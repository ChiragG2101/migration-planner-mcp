// Re-checker parentage and lockfile reads (D40). Offline: recorded GitHub commit
// payloads under test/fixtures/github/, plus a local origin so the fetch depth
// is exercised with no network. parentageHolds is not weakened: an empty parent
// list fails, and so does a base that is not the first parent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parentageHolds } from '../../../eval/caseVet.js';
import {
  fetchPinnedCommits,
  lockfileVersion,
  parentsFromGithubCommit,
  parentsFromRevList,
  readMergeParents,
} from '../../../scripts/verify-case.js';
import { repoRoot } from '../../helpers.js';

const fixture = (name: string): string => path.join(repoRoot, 'test', 'fixtures', 'github', name);
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIDE = 'cccccccccccccccccccccccccccccccccccccccc';
const PLANTED = '0000000000000000000000000000000000000000';

describe('recorded GitHub commit parents', () => {
  it('a one-parent commit passes only for that parent', () => {
    const commit = JSON.parse(readFileSync(fixture('commit-one-parent.json'), 'utf8')) as { parents: { sha: string }[] };
    const parents = parentsFromGithubCommit(commit);
    expect(parents).toEqual([BASE]);
    expect(parentageHolds(BASE, parents)).toBe(true);
    expect(parentageHolds(PLANTED, parents)).toBe(false);
  });

  it('a merge passes for the first parent and fails for the second', () => {
    const commit = JSON.parse(readFileSync(fixture('commit-two-parents.json'), 'utf8')) as { parents: { sha: string }[] };
    const parents = parentsFromGithubCommit(commit);
    expect(parents).toEqual([BASE, SIDE]);
    expect(parentageHolds(BASE, parents)).toBe(true);
    expect(parentageHolds(SIDE, parents)).toBe(false);
    expect(parentageHolds(PLANTED, parents)).toBe(false);
  });

  it('the depth-1 rev-list shape has no parents and parentage fails', () => {
    const merge = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(parentsFromRevList(`${merge}\n`)).toEqual([]);
    expect(parentageHolds(BASE, parentsFromRevList(merge))).toBe(false);
    expect(parentsFromRevList(`${merge} ${BASE}\n`)).toEqual([BASE]);
    expect(parentageHolds(BASE, parentsFromRevList(`${merge} ${BASE}`))).toBe(true);
  });
});

describe('merge fetch keeps parents (INV-61)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('depth 2 returns the real first parent, and a planted base still fails', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-verify-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const origin = path.join(work, 'origin');
    const clone = path.join(work, 'clone');
    const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', '--template=', origin]);
    gitAt(origin, 'config', 'user.email', 't@example.com');
    gitAt(origin, 'config', 'user.name', 't');
    writeFileSync(path.join(origin, 'f'), 'base\n');
    gitAt(origin, 'add', 'f');
    gitAt(origin, 'commit', '-q', '-m', 'base');
    const base = gitAt(origin, 'rev-parse', 'HEAD').trim();
    gitAt(origin, 'checkout', '-q', '-b', 'side');
    writeFileSync(path.join(origin, 'g'), 'side\n');
    gitAt(origin, 'add', 'g');
    gitAt(origin, 'commit', '-q', '-m', 'side');
    const side = gitAt(origin, 'rev-parse', 'HEAD').trim();
    gitAt(origin, 'checkout', '-q', 'main');
    gitAt(origin, 'merge', '-q', '--no-ff', 'side', '-m', 'merge');
    const merge = gitAt(origin, 'rev-parse', 'HEAD').trim();
    gitAt(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');

    execFileSync('git', ['init', '-q', '-b', 'main', '--template=', clone]);
    gitAt(clone, 'remote', 'add', 'origin', origin);
    const git = (...args: string[]): string => gitAt(clone, ...args);
    expect(fetchPinnedCommits(git, base, merge)).toEqual({ baseOk: true, mergeOk: true });
    const parents = readMergeParents(git, merge);
    expect(parents).toEqual([base, side]);
    expect(parentageHolds(base, parents)).toBe(true);
    expect(parentageHolds(side, parents)).toBe(false);
    expect(parentageHolds(PLANTED, parents)).toBe(false);
    expect(parentageHolds(base, [])).toBe(false);
  });
});

describe('lockfile version reader', () => {
  it('reads yarn.lock and pnpm-lock.yaml, and falls back to a workspace manifest', () => {
    expect(lockfileVersion(fixture('yarn-checkout'), 'next')).toBe('14.2.35');
    expect(lockfileVersion(fixture('pnpm-checkout'), 'next')).toBe('14.2.35');
    expect(lockfileVersion(fixture('manifest-only'), 'next')).toBe('13.5.6');
    expect(lockfileVersion(fixture('manifest-only'), 'react')).toBeNull();
  });

  it('reads package-lock.json and does not guess when a lockfile pins two versions', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(
        path.join(work, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      );
      expect(lockfileVersion(work, 'next')).toBe('14.2.35');
      rmSync(path.join(work, 'package-lock.json'));
      writeFileSync(
        path.join(work, 'package.json'),
        JSON.stringify({ dependencies: { next: '^14.2.35' } }),
      );
      writeFileSync(
        path.join(work, 'yarn.lock'),
        ['next@^13.0.0:', '  version "13.5.6"', 'next@^15.0.0:', '  version "15.5.23"', ''].join('\n'),
      );
      expect(lockfileVersion(work, 'next')).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('uses the manifest spec to pick one yarn pin, and a broken lockfile is not a pin', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ dependencies: { next: '^14.2.35' } }));
      writeFileSync(
        path.join(work, 'yarn.lock'),
        ['next@^13.0.0:', '  version "13.5.6"', 'next@^14.2.35:', '  version "14.2.35"', ''].join('\n'),
      );
      expect(lockfileVersion(work, 'next')).toBe('14.2.35');
      writeFileSync(path.join(work, 'package-lock.json'), '{');
      expect(lockfileVersion(work, 'next')).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reads every lockfile: pins that differ across files, or a later broken file, are not guessed', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ dependencies: { next: '^13.5.6' } }));
      writeFileSync(
        path.join(work, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      );
      writeFileSync(path.join(work, 'yarn.lock'), ['next@^14.2.35:', '  version "14.2.35"', ''].join('\n'));
      expect(lockfileVersion(work, 'next')).toBe('14.2.35');
      writeFileSync(path.join(work, 'yarn.lock'), ['next@^15.0.0:', '  version "15.5.23"', ''].join('\n'));
      expect(lockfileVersion(work, 'next')).toBeNull();
      rmSync(path.join(work, 'yarn.lock'));
      writeFileSync(path.join(work, 'pnpm-lock.yaml'), 'importers: [\n');
      expect(lockfileVersion(work, 'next')).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reads a nested yarn.lock when the root has no lockfile', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      mkdirSync(path.join(work, 'app', 'web'), { recursive: true });
      writeFileSync(path.join(work, 'app', 'web', 'package.json'), JSON.stringify({ dependencies: { next: '^15.5.7' } }));
      writeFileSync(path.join(work, 'app', 'web', 'yarn.lock'), ['next@^15.5.7:', '  version "15.5.7"', ''].join('\n'));
      expect(lockfileVersion(work, 'next')).toBe('15.5.7');
      writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }));
      expect(lockfileVersion(work, 'next')).toBe('14.2.35');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reads a poetry.lock pin, a requirements == pin, and a lockfile nested in a workspace', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(path.join(work, 'requirements.txt'), 'Django==3.2.25\nrequests>=2\n');
      expect(lockfileVersion(work, 'django')).toBe('3.2.25');
      rmSync(path.join(work, 'requirements.txt'));
      mkdirSync(path.join(work, 'django'), { recursive: true });
      writeFileSync(
        path.join(work, 'django', 'poetry.lock'),
        '[[package]]\nname = "Django"\nversion = "3.1.7"\n\n[[package]]\nname = "requests"\nversion = "2.28.0"\n',
      );
      expect(lockfileVersion(work, 'django')).toBe('3.1.7');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not guess a Python version from a range, two pins, or a lockfile that does not parse', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(path.join(work, 'requirements.txt'), 'django>=3.2\n');
      expect(lockfileVersion(work, 'django')).toBeNull();
      writeFileSync(
        path.join(work, 'poetry.lock'),
        '[[package]]\nname = "django"\nversion = "3.1.7"\n\n[[package]]\nname = "django"\nversion = "4.2.30"\n',
      );
      expect(lockfileVersion(work, 'django')).toBeNull();
      writeFileSync(path.join(work, 'requirements.txt'), 'django==3.2.25\n');
      writeFileSync(path.join(work, 'poetry.lock'), '[[package]]\nname = "django"\nversion = "4.2.30"\n');
      expect(lockfileVersion(work, 'django')).toBeNull();
      writeFileSync(path.join(work, 'poetry.lock'), '[[package]]\nname =\n');
      expect(lockfileVersion(work, 'django')).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('returns null when workspace manifests name two different versions and no lockfile pins one', () => {
    const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-lock-'));
    try {
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
      mkdirSync(path.join(work, 'packages', 'a'), { recursive: true });
      mkdirSync(path.join(work, 'packages', 'b'), { recursive: true });
      writeFileSync(path.join(work, 'packages', 'a', 'package.json'), JSON.stringify({ dependencies: { next: '^13.5.6' } }));
      writeFileSync(path.join(work, 'packages', 'b', 'package.json'), JSON.stringify({ dependencies: { next: '^15.5.23' } }));
      expect(lockfileVersion(work, 'next')).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
