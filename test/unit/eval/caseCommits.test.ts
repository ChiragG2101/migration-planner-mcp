// Case commits (D17, INV-43): the pinned base commit is fetched into the eval
// workspace, replay uses a checkout only at that commit with a clean tree, and
// results.md is never rendered without a case that has recorded runs. Offline:
// a local origin stands in for the case's public repo.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutAtBase, fetchCaseCommit as fetchFrom, outcomeLine, type GitRunner } from '../../../eval/caseCommits.js';
import { assertCommitsAvailable, generate } from '../../../eval/runner.js';
import { Case } from '../../../eval/schema.js';
import { repoRoot } from '../../helpers.js';

const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

// The offline origin is a file:// URL; production allows only https://github.com/<owner>/<repo>.
const fileOrigin = (url: string): boolean => url.startsWith('file://');
const fetchCaseCommit = (dir: string, url: string, base: string): ReturnType<typeof fetchFrom> => fetchFrom(dir, url, base, undefined, fileOrigin);

describe('case commits', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** An origin with two commits; the case pins the first, so the origin's HEAD is not the base. */
  function origin(): { work: string; url: string; base: string; later: string } {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-case-commits-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const dir = path.join(work, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'main', '--template=', dir]);
    gitAt(dir, 'config', 'user.email', 't@example.com');
    gitAt(dir, 'config', 'user.name', 't');
    gitAt(dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    writeFileSync(path.join(dir, 'f'), 'base\n');
    gitAt(dir, 'add', 'f');
    gitAt(dir, 'commit', '-q', '-m', 'base');
    const base = gitAt(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'f'), 'later\n');
    gitAt(dir, 'commit', '-q', '-am', 'later');
    const later = gitAt(dir, 'rev-parse', 'HEAD').trim();
    return { work, url: pathToFileURL(dir).href, base, later };
  }

  it('fetches the pinned base commit into an empty folder, then leaves it alone', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-a');
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('fetched');
    expect(gitAt(dir, 'rev-parse', 'HEAD').trim()).toBe(o.base);
    expect(checkoutAtBase(dir, o.base)).toBe(realpathSync(dir));
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('present');
  });

  it('moves a clean checkout at another commit to the base', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-b');
    expect(fetchCaseCommit(dir, o.url, o.later)).toBe('fetched');
    expect(checkoutAtBase(dir, o.base)).toBeNull();
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('fetched');
    expect(checkoutAtBase(dir, o.base)).toBe(realpathSync(dir));
  });

  it('never discards edits: a dirty checkout is reported dirty, not reset', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-c');
    expect(fetchCaseCommit(dir, o.url, o.later)).toBe('fetched');
    writeFileSync(path.join(dir, 'f'), 'local edit\n');
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('dirty');
    expect(gitAt(dir, 'rev-parse', 'HEAD').trim()).toBe(o.later);
    expect(readFileSync(path.join(dir, 'f'), 'utf8')).toBe('local edit\n');
  });

  it('a commit the origin does not have is unavailable', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-d');
    expect(fetchCaseCommit(dir, o.url, '0000000000000000000000000000000000000000')).toBe('unavailable');
  });

  it('refuses case data git could read as an option, a non-GitHub URL or a short SHA, without running git', () => {
    const o = origin();
    const calls: string[][] = [];
    const spy = (): GitRunner => (...args) => {
      calls.push(args);
      return '';
    };
    const dir = path.join(o.work, '.work', 'case-f');
    const sha = o.base;
    expect(fetchFrom(dir, '--upload-pack=touch /tmp/PWNED; git-upload-pack', sha, spy)).toBe('refused');
    expect(fetchFrom(dir, '--upload-pack=touch /tmp/PWNED', sha, spy, () => true)).toBe('refused');
    expect(fetchFrom(dir, 'https://github.com/owner/repo --upload-pack=x', sha, spy)).toBe('refused');
    expect(fetchFrom(dir, 'https://gitlab.com/owner/repo', sha, spy)).toBe('refused');
    expect(fetchFrom(dir, o.url, sha, spy)).toBe('refused'); // file:// is test-only
    expect(fetchFrom(dir, 'https://github.com/owner/repo', sha.slice(0, 12), spy)).toBe('refused');
    expect(fetchFrom(dir, 'https://github.com/owner/repo', '--all', spy)).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('ends git options before the URL and turns hooks off', () => {
    const calls: string[][] = [];
    const spy = (): GitRunner => (...args) => {
      calls.push(args);
      return '';
    };
    const o = origin();
    const sha = o.base;
    fetchFrom(path.join(o.work, '.work', 'case-g'), 'https://github.com/owner/repo', sha, spy);
    const fetch = calls.find((c) => c.includes('fetch'))!;
    expect(fetch.slice(-3)).toEqual(['--', 'https://github.com/owner/repo', sha]);
    expect(fetch.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/dev/null']);
    expect(calls.find((c) => c.includes('checkout'))!.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/dev/null']);
  });

  it('names each failure with its own remedy', () => {
    const sha = 'a'.repeat(40);
    expect(outcomeLine('dirty', 'c', sha)).toMatch(/^FAIL case_checkout_dirty: c: .*local edits/);
    expect(outcomeLine('unavailable', 'c', sha)).toMatch(/^FAIL case_commit_unavailable: c @ a{40}: remedy is `npm run cases:verify`/);
    expect(outcomeLine('refused', 'c', sha)).toMatch(/^FAIL case_record_invalid: c: .*nothing was run/);
    expect(outcomeLine('fetched', 'c', sha)).toBe(`fetched: c @ ${sha}`);
  });

  it('replay refuses a checkout off the base or with a dirty tree', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-e');
    expect(checkoutAtBase(dir, o.base)).toBeNull(); // missing
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('fetched');
    writeFileSync(path.join(dir, 'f'), 'drift\n');
    expect(checkoutAtBase(dir, o.base)).toBeNull(); // dirty
    gitAt(dir, 'checkout', '-q', '--', 'f');
    expect(checkoutAtBase(dir, o.base)).toBe(realpathSync(dir));
    expect(checkoutAtBase(dir, o.later)).toBeNull(); // HEAD is not the pinned commit
  });
});

describe('case records name only a GitHub repo and full SHAs', () => {
  const good = JSON.parse(readFileSync(path.join(repoRoot, 'eval/cases/nextjs-scaffold-move-43/case.json'), 'utf8')) as Record<string, unknown>;

  it('every committed case passes, and option-shaped or partial values fail', () => {
    for (const id of readdirSync(path.join(repoRoot, 'eval/cases'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const raw = JSON.parse(readFileSync(path.join(repoRoot, 'eval/cases', id.name, 'case.json'), 'utf8')) as unknown;
      expect(Case.safeParse(raw).success, id.name).toBe(true);
    }
    const bad: Record<string, unknown>[] = [
      { repo_url: '--upload-pack=touch /tmp/PWNED; git-upload-pack' },
      { repo_url: 'https://github.com/owner/repo --upload-pack=x' },
      { repo_url: 'file:///tmp/origin' },
      { repo_url: 'https://github.com/owner/repo.git/../x' },
      { base_commit: String(good['base_commit']).slice(0, 12) },
      { merge_commit: '--all' },
      { base_commit: String(good['base_commit']).toUpperCase() },
    ];
    for (const patch of bad) expect(Case.safeParse({ ...good, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });
});

describe('results.md fails closed on a missing case commit', () => {
  it('names every unavailable case', () => {
    expect(() => assertCommitsAvailable([])).not.toThrow();
    expect(() => assertCommitsAvailable(['a', 'b'])).toThrow(/^case_commit_unavailable: a, b /);
  });

  it('generate refuses to render when no case checkout is at its base', async () => {
    await expect(generate(() => null)).rejects.toThrow(/case_commit_unavailable: nextjs-/);
  });
});
