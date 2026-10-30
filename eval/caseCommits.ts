// Case commits (M7 task 3, D17): eval tooling fetches each golden case's pinned
// base commit into eval/.work/<id>, outside the engine (INV-40), and CI caches
// that folder. Replay uses a checkout only when its HEAD is the pinned base
// commit and its tree is clean; anything else is `case_commit_unavailable`, so a
// case is never scored on the wrong code and never silently skipped.
//
//   npm run cases:fetch    fetch every case with recorded runs that is not at its base yet
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalRoot, loadBaselineRuns, loadCases, loadEngineRuns, type LoadedCase } from './load.js';

/** Runs git in one checkout folder and returns stdout; throws on a non-zero exit. */
export type GitRunner = (...args: string[]) => string;

export const workDir = (): string => path.join(evalRoot(), '.work');

const gitIn =
  (dir: string): GitRunner =>
  (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** True when the folder is a git checkout whose HEAD is `base` and whose tree is clean. */
export function atBase(git: GitRunner, base: string): boolean {
  try {
    return git('rev-parse', 'HEAD').trim() === base && git('status', '--porcelain').trim() === '';
  } catch {
    return false;
  }
}

/** The checkout folder for a case when it is at its pinned base commit, or null (`case_commit_unavailable`). */
export function checkoutAtBase(dir: string, base: string): string | null {
  if (!existsSync(path.join(dir, '.git'))) return null;
  return atBase(gitIn(dir), base) ? realpathSync(dir) : null;
}

export type FetchOutcome = 'present' | 'fetched' | 'unavailable';

/**
 * Bring `dir` to the pinned base commit: a depth-1 fetch of that one commit and
 * a detached checkout. A checkout already at the base is left alone, and a dirty
 * one is never touched (a maintainer's edits are not discarded).
 */
export function fetchCaseCommit(dir: string, repoUrl: string, base: string, makeGit: (dir: string) => GitRunner = gitIn): FetchOutcome {
  const git = makeGit(dir);
  const isRepo = existsSync(path.join(dir, '.git'));
  if (isRepo && atBase(git, base)) return 'present';
  if (isRepo && git('status', '--porcelain').trim() !== '') return 'unavailable';
  try {
    if (!isRepo) {
      mkdirSync(dir, { recursive: true });
      git('init', '-q');
    }
    git('fetch', '-q', '--depth', '1', '--no-tags', repoUrl, base);
    git('-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', base);
  } catch {
    return 'unavailable';
  }
  return atBase(git, base) ? 'fetched' : 'unavailable';
}

/** The cases replay needs a checkout for: those with truth and at least one recorded run. */
export function casesNeedingCommits(cases: readonly LoadedCase[], promptVersion: string): LoadedCase[] {
  return cases.filter((c) => c.truth && (loadEngineRuns(c.case.id, promptVersion).length > 0 || loadBaselineRuns(c.case.id).length > 0));
}

function main(): number {
  const top = path.dirname(evalRoot());
  const manifest = JSON.parse(readFileSync(path.join(top, 'prompts', 'manifest.json'), 'utf8')) as { current: string };
  let failed = 0;
  for (const c of casesNeedingCommits(loadCases(), manifest.current)) {
    const outcome = fetchCaseCommit(path.join(workDir(), c.case.id), c.case.repo_url, c.case.base_commit);
    if (outcome === 'unavailable') failed += 1;
    const line = `${outcome === 'unavailable' ? 'FAIL case_commit_unavailable' : outcome}: ${c.case.id} @ ${c.case.base_commit}\n`;
    (outcome === 'unavailable' ? process.stderr : process.stdout).write(line);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
