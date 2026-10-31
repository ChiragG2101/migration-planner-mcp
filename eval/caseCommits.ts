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
import { FULL_SHA, GITHUB_REPO_URL } from './schema.js';

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

/**
 * `refused`: the URL or SHA is not one git may be given (nothing ran). `dirty`:
 * the checkout has local edits, which are never discarded. `unavailable`: the
 * pinned commit could not be fetched (`case_commit_unavailable`).
 */
export type FetchOutcome = 'present' | 'fetched' | 'refused' | 'dirty' | 'unavailable';

const isGithubRepo = (url: string): boolean => GITHUB_REPO_URL.test(url);

/**
 * Bring `dir` to the pinned base commit: a depth-1 fetch of that one commit and
 * a detached checkout, with hooks off. A checkout already at the base is left
 * alone, and a dirty one is never touched (a maintainer's edits are not
 * discarded). The URL and SHA are checked before git sees them, and `--` ends
 * the options, so case data can never be read as a git option.
 */
export function fetchCaseCommit(
  dir: string,
  repoUrl: string,
  base: string,
  makeGit: (dir: string) => GitRunner = gitIn,
  /** Test-only: the offline tests fetch from a local file:// origin. */
  allowUrl: (url: string) => boolean = isGithubRepo,
): FetchOutcome {
  if (!allowUrl(repoUrl) || repoUrl.startsWith('-') || !FULL_SHA.test(base)) return 'refused';
  const git = makeGit(dir);
  const isRepo = existsSync(path.join(dir, '.git'));
  if (isRepo && atBase(git, base)) return 'present';
  if (isRepo && git('status', '--porcelain').trim() !== '') return 'dirty';
  try {
    if (!isRepo) {
      mkdirSync(dir, { recursive: true });
      git('init', '-q');
    }
    git('-c', 'core.hooksPath=/dev/null', 'fetch', '-q', '--depth', '1', '--no-tags', '--', repoUrl, base);
    git('-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', base);
  } catch {
    return 'unavailable';
  }
  return atBase(git, base) ? 'fetched' : 'unavailable';
}

/** The line `cases:fetch` prints for one case, with the remedy each failure needs. */
export function outcomeLine(outcome: FetchOutcome, id: string, base: string): string {
  switch (outcome) {
    case 'present':
    case 'fetched':
      return `${outcome}: ${id} @ ${base}`;
    case 'refused':
      return `FAIL case_record_invalid: ${id}: repo_url must be https://github.com/<owner>/<repo> and base_commit a full SHA; nothing was run`;
    case 'dirty':
      return `FAIL case_checkout_dirty: ${id}: eval/.work/${id} has local edits; commit, stash or move them, then rerun`;
    case 'unavailable':
      return `FAIL case_commit_unavailable: ${id} @ ${base}: remedy is \`npm run cases:verify\` and the case-removal path (D15)`;
  }
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
    const ok = outcome === 'present' || outcome === 'fetched';
    if (!ok) failed += 1;
    (ok ? process.stdout : process.stderr).write(`${outcomeLine(outcome, c.case.id, c.case.base_commit)}\n`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
