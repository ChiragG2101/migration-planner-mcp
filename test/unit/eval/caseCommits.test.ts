// Case commits (D17, INV-43): the pinned base commit is fetched into the eval
// workspace, replay uses a checkout only at that commit with a clean tree, and
// results.md is never rendered without a case that has recorded runs. Offline:
// a local origin stands in for the case's public repo.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutAtBase, fetchCaseCommit } from '../../../eval/caseCommits.js';
import { assertCommitsAvailable, generate } from '../../../eval/runner.js';

const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

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

  it('never discards edits: a dirty checkout is unavailable, not reset', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-c');
    expect(fetchCaseCommit(dir, o.url, o.later)).toBe('fetched');
    writeFileSync(path.join(dir, 'f'), 'local edit\n');
    expect(fetchCaseCommit(dir, o.url, o.base)).toBe('unavailable');
    expect(gitAt(dir, 'rev-parse', 'HEAD').trim()).toBe(o.later);
    expect(readFileSync(path.join(dir, 'f'), 'utf8')).toBe('local edit\n');
  });

  it('a commit the origin does not have is unavailable', () => {
    const o = origin();
    const dir = path.join(o.work, '.work', 'case-d');
    expect(fetchCaseCommit(dir, o.url, '0000000000000000000000000000000000000000')).toBe('unavailable');
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

describe('results.md fails closed on a missing case commit', () => {
  it('names every unavailable case', () => {
    expect(() => assertCommitsAvailable([])).not.toThrow();
    expect(() => assertCommitsAvailable(['a', 'b'])).toThrow(/^case_commit_unavailable: a, b /);
  });

  it('generate refuses to render when no case checkout is at its base', async () => {
    await expect(generate(() => null)).rejects.toThrow(/case_commit_unavailable: nextjs-/);
  });
});
