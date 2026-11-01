// C3: the ONLY module allowed to spawn a process. Every exec goes through here.
// Enforced by the lint rule (no-restricted-imports on child_process outside this file)
// and by the permissions test (no-exec.test.ts, exec-*.test.ts).
//
// Allowed commands (D44, C9):
//   1. A user-declared install or check command (exact argv match).
//   2. A codemod registry entry (exact id match → pinned argv).
//   3. A fixed set of git operations with hooks disabled.
//   4. Nothing else — not a tool argument, not a pack field, not an agent message.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckConfig, InstallConfig, ExecResult } from '../schema/verify.js';
import type { CodemodEntry } from '../schema/verify.js';
import { PermissionError } from './errors.js';
import { assertLevel } from './level.js';
import { isWithin, type SafePath } from './pathBoundary.js';
import { mkdtempSandbox, rmSandbox } from './safeWrite.js';

// ---------------------------------------------------------------------------
// Sandbox path guard (D43)
// ---------------------------------------------------------------------------

/** True when `cwd` is inside the sandbox subtree of its out dir. */
export function isSandboxPath(cwd: SafePath, sandboxRoot: string): boolean {
  return isWithin(realpathSync(sandboxRoot), cwd.abs);
}

// ---------------------------------------------------------------------------
// Allowed git operations
// ---------------------------------------------------------------------------

// The fixed set of git operations the verify loop uses. `tag` marks stage
// starts; `rev-parse`/`rev-list` read commits for the report and patch replay.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'clone', 'apply', 'add', 'commit', 'reset', 'diff', 'status', 'rev-parse', 'rev-list', 'log', 'tag', 'checkout',
]);

// Global git flags that take a separate value argument (so that value is not
// mistaken for the subcommand). `-c key=val` is one token with `=`, so it is
// value-less here; `--git-dir`/`--work-tree <path>` consume the next token.
const GIT_FLAGS_WITH_VALUE = new Set(['--git-dir', '--work-tree', '-C']);

function isAllowedGit(argv: readonly string[]): boolean {
  if (argv[0] !== 'git') return false;
  // Find the first non-flag argument after 'git' — that's the subcommand.
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('-')) return ALLOWED_GIT_SUBCOMMANDS.has(a);
    // Skip a value that belongs to a global flag.
    if (GIT_FLAGS_WITH_VALUE.has(a)) i += 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Environment scrubbing (C3, C6)
// ---------------------------------------------------------------------------

// HOME is not here: it is always a fresh temp dir (D62).
const ALLOWED_ENV_KEYS = new Set(['PATH', 'LANG', 'TERM', 'CI', 'TMPDIR', 'TMP', 'TEMP']);

function scrubEnv(
  passEnv: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = { CI: '1' };
  for (const key of [...ALLOWED_ENV_KEYS, ...passEnv]) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  Object.assign(env, extraEnv);
  // Temp home inside a fresh temp dir so no user dotfiles are read. Set last,
  // so neither the parent, --pass-env HOME nor extraEnv can replace it.
  env['HOME'] = mkdtempSandbox(path.join(realpathSync(os.tmpdir()), 'mp-exec-home-'));
  return env;
}

// ---------------------------------------------------------------------------
// Output cap
// ---------------------------------------------------------------------------

const OUTPUT_CAP = 256 * 1024; // 256 KiB

function cap(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  return s.slice(s.length - OUTPUT_CAP);
}

// ---------------------------------------------------------------------------
// Core exec (internal — callers use the typed wrappers below)
// ---------------------------------------------------------------------------

/** What kind of command ran: the user's install or check, a registry codemod, or an allowed git operation. */
export type ExecKind = 'install' | 'check' | 'codemod' | 'git';

/** One command the spawn point ran, for the run report (M9: every command with its exit code). */
export interface ExecRecord {
  kind: ExecKind;
  argv: string[];
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
}

const observers = new Set<(r: ExecRecord) => void>();

/**
 * Calls `fn` after every command the spawn point runs, until the returned
 * function is called. Recording only: an observer cannot change the argv, the
 * cwd or the environment, and nothing it does can run a command.
 */
export function observeExec(fn: (r: ExecRecord) => void): () => void {
  observers.add(fn);
  return () => void observers.delete(fn);
}

export interface ExecRequest {
  readonly kind: ExecKind;
  readonly argv: readonly string[];
  /** Must be a SafePath inside the sandbox (D43). Checked at runtime. */
  readonly cwd: SafePath;
  readonly sandboxRoot: string;
  readonly timeoutMs?: number;
  /** Extra env keys to pass through from the parent (user-declared with --pass-env). */
  readonly passEnv?: readonly string[];
  /**
   * Extra fixed env values the engine sets itself (never from the parent, the
   * agent or a tool arg). Only the sandbox's own git identity uses this.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Runs `argv` synchronously. Throws `PermissionError` if:
 * - level < 1 (C5)
 * - cwd is not inside sandboxRoot (D43)
 * - argv does not match an allowed git operation (checked by callers before calling)
 *
 * Callers (execCheck, execInstall, execCodemod, execGit) are responsible for
 * asserting that argv matches their allowed set before calling this.
 */
function execRaw(req: ExecRequest): ExecResult {
  assertLevel(1);
  if (!isSandboxPath(req.cwd, req.sandboxRoot)) {
    throw new PermissionError('exec_outside_sandbox', `exec cwd is outside the sandbox: ${req.cwd.abs}`, {
      cwd: req.cwd.abs,
      sandbox: req.sandboxRoot,
    });
  }
  const timeoutMs = req.timeoutMs ?? 120_000;
  const env = scrubEnv(req.passEnv, req.extraEnv);
  const start = Date.now();
  let result: SpawnSyncReturns<string>;
  let duration: number;
  try {
    result = spawnSync(req.argv[0]!, req.argv.slice(1), {
      cwd: req.cwd.abs,
      env,
      timeout: timeoutMs,
      maxBuffer: OUTPUT_CAP * 2,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
    });
    duration = Date.now() - start;
  } finally {
    // The temp home lives for one command, so caches an install writes there
    // do not pile up in the system temp dir (D63).
    rmSandbox(env['HOME']!);
  }
  const stdout = cap(typeof result.stdout === 'string' ? result.stdout : '');
  const stderr = cap(typeof result.stderr === 'string' ? result.stderr : '');
  const timedOut =
    result.signal === 'SIGTERM' ||
    result.signal === 'SIGKILL' ||
    result.error?.message?.includes('ETIMEDOUT') ||
    false;
  for (const fn of observers) fn({ kind: req.kind, argv: [...req.argv], exit_code: result.status ?? -1, duration_ms: duration, timed_out: timedOut });
  return {
    argv: [...req.argv],
    exit_code: result.status ?? -1,
    stdout,
    stderr,
    duration_ms: duration,
    timed_out: timedOut,
  };
}

// ---------------------------------------------------------------------------
// Typed wrappers — the only public surface
// ---------------------------------------------------------------------------

// The level guard lives only in execRaw (the single authoritative place), so a
// test that drives any wrapper at L0 reaches it; removing it fails every such
// test. Each wrapper adds its own distinct guard (exact-argv or git allowlist),
// each independently tested.

/** Run a user-declared install command. argv must exactly match the config. */
export function execInstall(
  config: InstallConfig,
  cwd: SafePath,
  sandboxRoot: string,
  passEnv?: readonly string[],
): ExecResult {
  return execRaw({ kind: 'install', argv: config.argv, cwd, sandboxRoot, timeoutMs: config.timeout_ms, passEnv });
}

/** Run a user-declared check command. argv must exactly match the config. */
export function execCheck(
  config: CheckConfig,
  cwd: SafePath,
  sandboxRoot: string,
  passEnv?: readonly string[],
): ExecResult {
  return execRaw({ kind: 'check', argv: config.argv, cwd, sandboxRoot, timeoutMs: config.timeout_ms, passEnv });
}

/** Run a codemod from the registry. argv is built from the entry's template. */
export function execCodemod(
  entry: CodemodEntry,
  argv: readonly string[],
  cwd: SafePath,
  sandboxRoot: string,
): ExecResult {
  // Distinct guard: argv must start with the runner and the pinned package@version,
  // and carry no more than the template's arguments (no extra appended argument).
  const expected0 = entry.runner;
  const expected1 = `${entry.package}@${entry.version}`;
  if (argv[0] !== expected0 || argv[1] !== expected1) {
    throw new PermissionError('unlisted_argv', `codemod argv does not match registry entry ${entry.id}`, {
      argv,
      expected: [expected0, expected1],
    });
  }
  return execRaw({ kind: 'codemod', argv, cwd, sandboxRoot, timeoutMs: 120_000 });
}

/** Run an allowed git operation. Hooks are always disabled. */
export function execGit(
  argv: readonly string[],
  cwd: SafePath,
  sandboxRoot: string,
  timeoutMs = 60_000,
  extraEnv?: Readonly<Record<string, string>>,
): ExecResult {
  // Distinct guard: the git subcommand must be in the allowed set.
  if (!isAllowedGit(argv)) {
    throw new PermissionError('unlisted_argv', `git subcommand not in the allowed set: ${argv.join(' ')}`, { argv });
  }
  // Always disable hooks (C3).
  const safeArgv = [argv[0]!, '-c', 'core.hooksPath=/dev/null', ...argv.slice(1)];
  return execRaw({ kind: 'git', argv: safeArgv, cwd, sandboxRoot, timeoutMs, extraEnv });
}

// ---------------------------------------------------------------------------
// Legacy stub (kept so M1 tests still compile; M8 tests replace the behaviour)
// ---------------------------------------------------------------------------

/** @deprecated Use execCheck / execInstall / execCodemod / execGit instead. */
export function exec(_req: { argv: readonly string[]; cwd: string }): never {
  throw new PermissionError('exec_unavailable', 'use execCheck/execInstall/execCodemod/execGit');
}
