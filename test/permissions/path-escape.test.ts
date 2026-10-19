// INV-4 (C4): resolveInside rejects `..`, absolute paths and symlink escapes.
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveInside } from '../../src/security/pathBoundary.js';
import { expectPermission, symlink, tmpDir, writeTree } from '../helpers.js';

let base: string;
let repo: string;

beforeAll(() => {
  base = tmpDir();
  repo = path.join(base, 'repo');
  writeTree(base, {
    'repo/src/a.ts': 'export const a = 1;\n',
    'sibling/secret.txt': 'sibling secret\n',
  });
  symlink('/etc', path.join(repo, 'etc-link'));
  symlink('../sibling', path.join(repo, 'sibling-link'));
  symlink('../sibling/secret.txt', path.join(repo, 'secret-link.txt'));
  symlink('src/a.ts', path.join(repo, 'inside-link.ts'));
  symlink('repo', path.join(base, 'repo-link'));
  symlink('repo/src', path.join(base, 'into-repo'));
});

describe('resolveInside', () => {
  it('accepts a path inside the root and carries the repo id', () => {
    const sp = resolveInside(repo, 'src/a.ts', 'repo123');
    expect(sp.rel).toBe('src/a.ts');
    expect(sp.repoId).toBe('repo123');
    expect(sp.abs).toBe(path.join(repo, 'src', 'a.ts'));
  });

  it('accepts an absolute path that is inside the root', () => {
    expect(resolveInside(repo, path.join(repo, 'src/a.ts')).rel).toBe('src/a.ts');
  });

  it('realpaths the root too, so a root reached through a symlink still works', () => {
    const sp = resolveInside(path.join(base, 'repo-link'), 'src/a.ts');
    expect(sp.rel).toBe('src/a.ts');
    expect(sp.root).toBe(repo);
  });

  it('rejects an absolute path outside the root even when it links back in', () => {
    expectPermission(() => resolveInside(repo, path.join(base, 'into-repo', 'a.ts')), 'outside_root');
  });

  it('accepts a symlink that stays inside the root', () => {
    const sp = resolveInside(repo, 'inside-link.ts');
    expect(sp.rel).toBe('src/a.ts');
    expect(sp.requested).toBe('inside-link.ts');
  });

  it('rejects .. traversal', () => {
    expectPermission(() => resolveInside(repo, '../sibling/secret.txt'), 'outside_root');
    expectPermission(() => resolveInside(repo, 'src/../../sibling/secret.txt'), 'outside_root');
    expectPermission(() => resolveInside(repo, '..'), 'outside_root');
  });

  it('rejects .. that leaves the root, even when it comes back in', () => {
    expectPermission(() => resolveInside(repo, '../repo/src/a.ts'), 'outside_root');
  });

  it('rejects an absolute path outside the root', () => {
    expectPermission(() => resolveInside(repo, '/etc/passwd'), 'outside_root');
    expectPermission(() => resolveInside(repo, path.join(base, 'sibling', 'secret.txt')), 'outside_root');
  });

  it('rejects a symlink to /etc', () => {
    expectPermission(() => resolveInside(repo, 'etc-link'), 'outside_root');
    expectPermission(() => resolveInside(repo, 'etc-link/passwd'), 'outside_root');
  });

  it('rejects a symlink to a sibling directory', () => {
    expectPermission(() => resolveInside(repo, 'sibling-link'), 'outside_root');
    expectPermission(() => resolveInside(repo, 'sibling-link/secret.txt'), 'outside_root');
    expectPermission(() => resolveInside(repo, 'secret-link.txt'), 'outside_root');
  });

  it('rejects a missing path under an escaping symlink', () => {
    expectPermission(() => resolveInside(repo, 'sibling-link/not-there/x.txt'), 'outside_root');
  });
});
