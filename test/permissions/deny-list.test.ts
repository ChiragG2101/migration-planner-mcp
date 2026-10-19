// INV-5 (C4): deny-listed files are never read, even when asked for directly by path.
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { addUserDenies, isDenied, isDeniedRel } from '../../src/security/denyList.js';
import { resolveInside, type SafePath } from '../../src/security/pathBoundary.js';
import { listDir, lstatRequested, readBytes, readText, statPath } from '../../src/security/safeRead.js';
import { expectPermission, symlink, tmpDir, writeTree } from '../helpers.js';

const SECRET = 'TOP_SECRET_VALUE';
const denied = [
  '.env',
  '.env.local',
  '.env.example',
  'id_rsa',
  'id_rsa.pub',
  'certs/server.pem',
  'certs/tls.key',
  'certs/client.p12',
  '.pypirc',
  '.npmrc',
  'apps/web/.env.production',
  '.git/config',
  '.git/index',
  'node_modules/next/dist/server.js',
  '.venv/lib/python3.12/site-packages/django/__init__.py',
  'venv/bin/activate',
];
let repo: string;

beforeAll(() => {
  repo = tmpDir();
  writeTree(repo, Object.fromEntries([...denied, 'src/ok.ts'].map((f) => [f, `${SECRET}\n`])));
  writeTree(repo, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': 'abc\n', 'node_modules/next/package.json': '{}' });
  symlink('.env', path.join(repo, 'notes.txt'));
  symlink('src/ok.ts', path.join(repo, '.env.staging'));
});

describe('deny list', () => {
  it.each(denied)('refuses to read %s', (rel) => {
    const sp = resolveInside(repo, rel);
    expect(isDenied(sp)).toBe(true);
    const err = expectPermission(() => readText(sp), 'denied');
    expect(err.message).not.toContain(SECRET);
    expectPermission(() => readBytes(sp), 'denied');
  });

  it('refuses a symlink that points at a denied file', () => {
    expectPermission(() => readText(resolveInside(repo, 'notes.txt')), 'denied');
  });

  it('refuses a denied name even when it is a symlink to an allowed file', () => {
    expectPermission(() => readText(resolveInside(repo, '.env.staging')), 'denied');
  });

  it('allows ordinary files, git HEAD and refs, and package.json inside node_modules', () => {
    expect(readText(resolveInside(repo, 'src/ok.ts'))).toContain(SECRET);
    expect(readText(resolveInside(repo, '.git/HEAD'))).toContain('refs/heads/main');
    expect(isDeniedRel('.git/refs/heads/main')).toBe(false);
    expect(isDeniedRel('.git/packed-refs')).toBe(false);
    expect(isDeniedRel('node_modules/next/package.json')).toBe(false);
  });

  it('refuses a forged SafePath that did not come from resolveInside', () => {
    const forged = { root: repo, abs: path.join(repo, '.env'), rel: 'src/ok.ts', requested: 'src/ok.ts', repoId: null };
    expectPermission(() => readText(forged as unknown as SafePath), 'forged_path');
  });

  it('statPath, listDir and lstatRequested refuse denied files and folders, and forged paths', () => {
    for (const rel of ['.env', '.git', 'node_modules']) {
      const sp = resolveInside(repo, rel);
      expectPermission(() => statPath(sp), 'denied');
      expectPermission(() => listDir(sp), 'denied');
      expectPermission(() => lstatRequested(sp), 'denied');
    }
    const forged = { root: repo, abs: path.join(repo, 'src'), rel: 'src', requested: 'src', repoId: null } as unknown as SafePath;
    expectPermission(() => statPath(forged), 'forged_path');
    expectPermission(() => listDir(forged), 'forged_path');
    expectPermission(() => lstatRequested(forged), 'forged_path');
    // The same calls on an allowed folder work, so the refusals above are the deny list, not an error.
    const src = resolveInside(repo, 'src');
    expect(statPath(src).isDirectory()).toBe(true);
    expect(listDir(src).map((d) => d.name)).toEqual(['ok.ts']);
    expect(lstatRequested(src).isDirectory()).toBe(true);
  });

  it('user entries only add to the defaults', () => {
    expect(isDeniedRel('private/notes.md')).toBe(false);
    addUserDenies(['private/', '*.secret']);
    expect(isDeniedRel('private/notes.md')).toBe(true);
    expect(isDeniedRel('a/b/c.secret')).toBe(true);
    expect(isDeniedRel('.env')).toBe(true);
    expect(isDeniedRel('src/ok.ts')).toBe(false);
  });
});
