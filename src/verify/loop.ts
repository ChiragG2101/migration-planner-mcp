// Stage verify loop (M8). Orchestrates: codemods → patch → checks → gate 7.
// Called by verifyStage and submitStagePatch core functions.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execCheck, execInstall, execCodemod, execGit } from '../security/exec.js';
import { assertLevel } from '../security/level.js';
import { PermissionError } from '../security/errors.js';
import { isDenied } from '../security/denyList.js';
import { writeFileSandbox, mkdirSandbox } from '../security/safeWrite.js';
import { readTextSandbox } from '../security/safeRead.js';
import type { CheckConfig, InstallConfig, CheckResult, CodemodResult, Gate7Result, StageDecision } from '../schema/verify.js';
import { getCodemodEntry, buildCodemodArgv } from './codemods.js';
import { parseJUnit } from './junit.js';
import { snapshotTests, checkTestIntegrity, type TestSnapshot } from './testIntegrity.js';
import type { Sandbox } from './sandbox.js';
import type { Finding } from '../schema/finding.js';

// ---------------------------------------------------------------------------
// Output tail helper
// ---------------------------------------------------------------------------

const TAIL_CHARS = 8192;
function tail(s: string): string {
  return s.length > TAIL_CHARS ? s.slice(s.length - TAIL_CHARS) : s;
}

// ---------------------------------------------------------------------------
// Run install commands
// ---------------------------------------------------------------------------

export function runInstall(
  sandbox: Sandbox,
  installs: readonly InstallConfig[],
  passEnv?: readonly string[],
): void {
  assertLevel(1);
  for (const cfg of installs) {
    const result = execInstall(cfg, sandbox.rootPath, sandbox.root, passEnv);
    if (result.exit_code !== 0) {
      throw new Error(`install command failed (exit ${result.exit_code}): ${tail(result.stderr)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run checks
// ---------------------------------------------------------------------------

function runOneCheck(sandbox: Sandbox, cfg: CheckConfig, passEnv?: readonly string[]): { result: ReturnType<typeof execCheck>; junit: CheckResult['junit'] } {
  const result = execCheck(cfg, sandbox.rootPath, sandbox.root, passEnv);
  let junit: CheckResult['junit'] = null;
  if (cfg.junit_path) {
    try {
      const sp = sandbox.resolve(cfg.junit_path);
      junit = parseJUnit(readTextSandbox(sp));
    } catch {
      junit = null; // the runner did not write the report; leave null
    }
  }
  return { result, junit };
}

/**
 * Run every check. `allowFlakyRerun` enables a single immediate rerun of a
 * check that failed when it was not failing at baseline: if the rerun passes,
 * the check is marked `flaky` (never a silent pass; plan task 6).
 */
export function runChecks(
  sandbox: Sandbox,
  checks: readonly CheckConfig[],
  baselineFailingNames: ReadonlySet<string>,
  allowFlakyRerun = false,
  passEnv?: readonly string[],
): CheckResult[] {
  assertLevel(1);
  return checks.map((cfg) => {
    const start = Date.now();
    let { result, junit } = runOneCheck(sandbox, cfg, passEnv);
    let status: CheckResult['status'];
    let flaky = false;
    if (result.timed_out) {
      status = 'timeout';
    } else if (result.exit_code === 0) {
      status = 'pass';
    } else if (baselineFailingNames.has(cfg.name)) {
      status = 'baseline_failing';
    } else {
      status = 'fail';
      // Single rerun to catch a flaky failure (plan task 6).
      if (allowFlakyRerun) {
        const rerun = runOneCheck(sandbox, cfg, passEnv);
        if (!rerun.result.timed_out && rerun.result.exit_code === 0) {
          status = 'flaky';
          flaky = true;
          result = rerun.result;
          junit = rerun.junit;
        }
      }
    }
    const duration_ms = Date.now() - start;
    return {
      name: cfg.name,
      status,
      exit_code: result.exit_code,
      output_tail: (flaky ? '[passed on rerun — flaky]\n' : '') + tail(result.stdout + result.stderr),
      duration_ms,
      junit,
    };
  });
}

// ---------------------------------------------------------------------------
// Run codemods for a stage's findings
// ---------------------------------------------------------------------------

export function runCodemods(
  sandbox: Sandbox,
  findings: readonly Finding[],
): CodemodResult[] {
  assertLevel(1);
  const results: CodemodResult[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const codemodId = f.codemod;
    if (!codemodId || seen.has(codemodId)) continue;
    seen.add(codemodId);
    const entry = getCodemodEntry(codemodId);
    if (!entry) {
      results.push({ id: codemodId, status: 'codemod_unavailable', diff: '', duration_ms: 0 });
      continue;
    }
    const argv = buildCodemodArgv(entry, sandbox.root);
    const start = Date.now();
    const execResult = execCodemod(entry, argv, sandbox.rootPath, sandbox.root);
    const duration_ms = Date.now() - start;
    // Get the diff of what the codemod changed.
    const diffResult = execGit(['git', 'diff'], sandbox.rootPath, sandbox.root, 30_000);
    const diff = diffResult.stdout;
    results.push({
      id: codemodId,
      status: execResult.exit_code === 0 ? 'ok' : 'failed',
      diff,
      duration_ms,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Apply a patch (unified diff or file list)
// ---------------------------------------------------------------------------

/**
 * The set of file paths a unified diff touches. Reads the `+++`/`---` headers
 * and the `diff --git a/x b/y` lines, stripping the `a/`/`b/` prefixes.
 */
export function patchPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    let m = /^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/.exec(line);
    if (m && m[1] !== '/dev/null') paths.add(m[1]!);
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { paths.add(m[1]!); paths.add(m[2]!); }
  }
  return [...paths];
}

/**
 * Resolve every patched path inside the sandbox and refuse any that escapes
 * the sandbox or hits the deny list. Nothing is written if any path is bad
 * (plan task 6, test patch-escape-refused).
 */
export function assertPatchPathsSafe(sandbox: Sandbox, paths: readonly string[]): void {
  for (const rel of paths) {
    let safe;
    try {
      safe = sandbox.resolve(rel); // realpaths, rejects `..`, absolute, symlink escape
    } catch (err) {
      throw new PermissionError('patch_escape', `patch path escapes the sandbox: ${rel}`, { path: rel, cause: String(err) });
    }
    if (isDenied(safe)) {
      throw new PermissionError('patch_escape', `patch touches a deny-listed path: ${rel}`, { path: rel });
    }
  }
}

/**
 * Apply a patch to the sandbox. For a unified diff: check every path is safe,
 * run `git apply --check` first, then `git apply --index`. For a file list:
 * check each path then write it. Returns the resulting working-tree diff.
 */
export function applyPatch(
  sandbox: Sandbox,
  patch: string | Array<{ path: string; content: string }>,
): string {
  assertLevel(1);
  const runDir = path.dirname(sandbox.root); // <out>/<run_id>
  if (typeof patch === 'string') {
    assertPatchPathsSafe(sandbox, patchPaths(patch));
    const patchFile = path.join(runDir, `patch-${Date.now()}.diff`);
    writeFileSandbox(patchFile, patch);
    // Dry-run first so a bad patch never half-applies (plan task 6).
    const dry = execGit(['git', 'apply', '--check', '--index', patchFile], sandbox.rootPath, sandbox.root, 30_000);
    if (dry.exit_code !== 0) {
      throw new Error(`git apply --check failed (exit ${dry.exit_code}): ${tail(dry.stderr)}`);
    }
    const result = execGit(['git', 'apply', '--index', patchFile], sandbox.rootPath, sandbox.root, 30_000);
    if (result.exit_code !== 0) {
      throw new Error(`git apply failed (exit ${result.exit_code}): ${tail(result.stderr)}`);
    }
    const diffResult = execGit(['git', 'diff', '--cached'], sandbox.rootPath, sandbox.root, 30_000);
    return diffResult.stdout || patch;
  } else {
    assertPatchPathsSafe(sandbox, patch.map((p) => p.path));
    for (const { path: rel, content } of patch) {
      const safe = sandbox.resolve(rel);
      mkdirSandbox(path.dirname(safe.abs));
      writeFileSandbox(safe.abs, content);
    }
    execGit(['git', 'add', '-A'], sandbox.rootPath, sandbox.root, 30_000);
    const diffResult = execGit(['git', 'diff', '--cached'], sandbox.rootPath, sandbox.root, 30_000);
    return diffResult.stdout;
  }
}

// ---------------------------------------------------------------------------
// Patch hash
// ---------------------------------------------------------------------------

export function hashPatch(diff: string): string {
  return createHash('sha256').update(diff).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Reset sandbox to HEAD (rollback)
// ---------------------------------------------------------------------------

export function resetSandbox(sandbox: Sandbox): void {
  assertLevel(1);
  execGit(['git', 'reset', '--hard', 'HEAD'], sandbox.rootPath, sandbox.root, 30_000);
}

// ---------------------------------------------------------------------------
// Stage verification result
// ---------------------------------------------------------------------------

export interface StageVerifyResult {
  attempt: number;
  codemods: CodemodResult[];
  patchHash: string | null;
  checks: CheckResult[];
  gate7: Gate7Result;
  decision: StageDecision;
}

/**
 * Run codemods for a stage, return the diff and remaining findings.
 * Does NOT run checks — that happens in submitStagePatch.
 */
export function prepareStage(
  sandbox: Sandbox,
  findings: readonly Finding[],
): { codemods: CodemodResult[]; codemodDiff: string; remainingFindings: string[] } {
  assertLevel(1);
  const codemods = runCodemods(sandbox, findings);
  // Get the combined diff after all codemods.
  const diffResult = execGit(['git', 'diff'], sandbox.rootPath, sandbox.root, 30_000);
  const codemodDiff = diffResult.stdout;
  // Findings without a codemod (or whose codemod failed) need a manual patch.
  const coveredByCodemod = new Set(
    codemods.filter((r) => r.status === 'ok').map((r) => r.id),
  );
  const remainingFindings = findings
    .filter((f) => !f.codemod || !coveredByCodemod.has(f.codemod))
    .map((f) => f.id);
  return { codemods, codemodDiff, remainingFindings };
}

/**
 * After the agent has applied its patch (or if no patch is needed), run
 * checks and gate 7, then decide kept/rejected/unresolved.
 */
export async function evaluateStage(
  sandbox: Sandbox,
  beforeSnapshot: TestSnapshot,
  checks: readonly CheckConfig[],
  baselineFailingNames: ReadonlySet<string>,
  codemods: CodemodResult[],
  patchDiff: string,
  attempt: number,
  passEnv?: readonly string[],
): Promise<StageVerifyResult> {
  assertLevel(1);
  const checkResults = runChecks(sandbox, checks, baselineFailingNames, true, passEnv);
  const afterSnapshot = await snapshotTests(sandbox.root);
  const gate7 = checkTestIntegrity(beforeSnapshot, afterSnapshot);

  // A flaky check (passed on rerun) does not fail the stage, but is reported.
  const failedChecks = checkResults.filter((c) => c.status === 'fail' || c.status === 'timeout');
  const decision: StageDecision = gate7.pass && failedChecks.length === 0 ? 'kept' : 'rejected';

  return {
    attempt,
    codemods,
    patchHash: patchDiff.length > 0 ? hashPatch(patchDiff) : null,
    checks: checkResults,
    gate7,
    decision,
  };
}
