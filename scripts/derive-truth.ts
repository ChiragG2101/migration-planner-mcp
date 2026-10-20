// Derive a golden case's ground truth (M7 task 1). Diffs the base commit
// against the merge commit, maps the changed hunks at base to the usages
// find_usages finds at base, and writes eval/cases/<id>/truth.json. Truth is
// derived deterministically and is NEVER re-derived for an existing case with
// recorded runs (D15); the add-only check enforces that.
//
//   npm run truth:derive -- <case-id> [--work <dir>]
//
// Maintainer tooling: it fetches commits over the network and runs git, so it
// is outside the engine (src/ never imports scripts/, INV-40) and never runs in
// default CI. The diffing and hunk→usage mapping are factored into pure
// functions (deriveTruthFrom) so a tiny synthetic repo can test them offline.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snippetHash, sliceLines } from '../src/analysis/snippet.js';
import type { Usage } from '../src/schema/usage.js';
import { scanUsages } from '../eval/engineRun.js';
import { Case, Truth, type UsageSpan } from '../eval/schema.js';

const repoTop = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** A lockfile whose churn is excluded from edit size and from the touched-file source count. */
export function isLockfile(file: string): boolean {
  const base = path.basename(file);
  return (
    base === 'package-lock.json' ||
    base === 'yarn.lock' ||
    base === 'pnpm-lock.yaml' ||
    base === 'poetry.lock' ||
    base === 'Pipfile.lock' ||
    base === 'npm-shrinkwrap.json'
  );
}

/** A changed hunk at base: the file and the inclusive base-side line range the PR edited or removed. */
export interface ChangedHunk {
  file: string;
  start: number;
  end: number;
}

/** Parse `git diff --unified=0` output into base-side changed line ranges per file. */
export function parseDiffHunks(diff: string): ChangedHunk[] {
  const hunks: ChangedHunk[] = [];
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^--- a\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[1]!;
      continue;
    }
    if (line.startsWith('--- /dev/null')) {
      file = null;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // count 0 means a pure insertion at base; nothing at base changed, so skip.
      if (count > 0) hunks.push({ file, start, end: start + count - 1 });
    }
  }
  return hunks;
}

/** The source lines added or removed per file, lockfiles excluded, from `git diff --numstat`. */
export function parseNumstat(numstat: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const file = m[3]!;
    if (isLockfile(file)) continue;
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const removed = m[2] === '-' ? 0 : Number(m[2]);
    sizes[file] = (sizes[file] ?? 0) + added + removed;
  }
  return sizes;
}

/** A usage is "truth" when a changed hunk overlaps its base-side line span in the same file. */
function usageTouched(usage: Usage, hunks: readonly ChangedHunk[]): boolean {
  return hunks.some((h) => h.file === usage.file && h.start <= usage.line_end && usage.line_start <= h.end);
}

export interface DeriveInput {
  caseId: string;
  baseCommit: string;
  mergeCommit: string;
  /** Usages find_usages found at base. */
  usages: readonly Usage[];
  /** `git diff --unified=0 base..merge`. */
  diffUnified0: string;
  /** `git diff --numstat base..merge`. */
  numstat: string;
}

/**
 * The pure core: given base usages and the base..merge diff, compute truth.
 * A true changed usage carries the usage's own file, span and snippet_hash (as
 * found at base), so replay matches it to HEAD by those three (D17). Files with
 * no base usage are excluded from the truth usages but still listed in
 * touched_files (file precision) unless they are lockfiles.
 */
export function deriveTruthFrom(input: DeriveInput): Truth {
  const hunks = parseDiffHunks(input.diffUnified0);
  const changed = input.usages.filter((u) => usageTouched(u, hunks));
  const changedUsages: UsageSpan[] = changed.map((u) => ({
    file: u.file,
    line_start: u.line_start,
    line_end: u.line_end,
    snippet_hash: u.snippet_hash,
  }));
  const editSize = parseNumstat(input.numstat);
  const touched = [...new Set(hunks.map((h) => h.file))].filter((f) => !isLockfile(f)).sort();
  return Truth.parse({
    case_id: input.caseId,
    base_commit: input.baseCommit,
    merge_commit: input.mergeCommit,
    changed_usages: changedUsages,
    touched_files: touched,
    edit_size: editSize,
    excluded_files: [],
  });
}

/** Recompute each usage's snippet_hash from the checked-out base tree, as a cross-check against find_usages. */
export function hashSpansAt(root: string, spans: readonly UsageSpan[]): UsageSpan[] {
  return spans.map((s) => {
    const text = readFileSync(path.join(root, s.file), 'utf8');
    return { ...s, snippet_hash: snippetHash(sliceLines(text, s.line_start, s.line_end)) };
  });
}

async function main(argv: string[]): Promise<number> {
  const caseId = argv[0];
  if (!caseId || caseId.startsWith('--')) {
    process.stderr.write('usage: npm run truth:derive -- <case-id> [--work <dir>]\n');
    return 1;
  }
  const top = repoTop();
  const casePath = path.join(top, 'eval', 'cases', caseId, 'case.json');
  if (!existsSync(casePath)) {
    process.stderr.write(`no case at ${casePath}\n`);
    return 1;
  }
  const kase = Case.parse(JSON.parse(readFileSync(casePath, 'utf8')));
  const truthPath = path.join(top, 'eval', 'cases', caseId, 'truth.json');
  if (existsSync(truthPath)) {
    process.stderr.write(`truth.json already exists for ${caseId}; it is never re-derived (D15). Remove the case under exception (b) to re-derive.\n`);
    return 1;
  }

  const workIdx = argv.indexOf('--work');
  const work = workIdx >= 0 ? argv[workIdx + 1]! : mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-truth-'));
  const clone = path.join(work, caseId);
  try {
    if (!existsSync(path.join(clone, '.git'))) {
      execFileSync('git', ['clone', '--no-checkout', kase.repo_url, clone], { stdio: 'inherit' });
    }
    const git = (...args: string[]): string => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' });
    git('fetch', '--depth', '1', 'origin', kase.base_commit);
    git('fetch', '--depth', '1', 'origin', kase.merge_commit);
    git('checkout', '--force', kase.base_commit);
    const diffUnified0 = git('diff', '--unified=0', `${kase.base_commit}..${kase.merge_commit}`);
    const numstat = git('diff', '--numstat', `${kase.base_commit}..${kase.merge_commit}`);
    const { usages } = await scanUsages(realpathSync(clone), { name: kase.source.framework }, { name: kase.target.framework, version: kase.target.version });
    const truth = deriveTruthFrom({ caseId, baseCommit: kase.base_commit, mergeCommit: kase.merge_commit, usages, diffUnified0, numstat });
    writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), truthPath)}: ${truth.changed_usages.length} changed usages, ${truth.touched_files.length} touched files\n`);
    return 0;
  } finally {
    if (workIdx < 0) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
