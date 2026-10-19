// INV-4, INV-5 (C4): on a walk, an entry outside the root or on the deny list
// is skipped and listed, never read; the scan carries on. A direct read of
// such a path still throws.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, scanRepo, type Engine } from '../../src/core/index.js';
import { resolveInside } from '../../src/security/pathBoundary.js';
import { readText } from '../../src/security/safeRead.js';
import { openDb } from '../../src/store/db.js';
import { expectPermission, symlink, tmpDir, writeTree } from '../helpers.js';

const ENV_SECRET = 'ENV_LOCAL_SECRET_7f3a';
const OUTSIDE_SECRET = 'OUTSIDE_SECRET_91c2';
let base: string;
let repo: string;
let out: string;
let engine: Engine;

beforeAll(() => {
  base = tmpDir();
  repo = path.join(base, 'repo');
  out = path.join(base, 'out');
  writeTree(base, {
    'repo/package.json': JSON.stringify({ name: 'r', dependencies: { next: '^14.0.0' } }),
    'repo/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
    'repo/.env.local': `API_TOKEN=${ENV_SECRET}\n`,
    'outside/secret.txt': `${OUTSIDE_SECRET}\n`,
  });
  symlink('../outside/secret.txt', path.join(repo, 'leak.txt'));
  symlink('/etc', path.join(repo, 'etc-link'));
  engine = createEngine({ out });
});

afterAll(() => closeEngine(engine));

describe('scan_repo walk refusals', () => {
  it('completes and lists the symlink out of the root and the .env.local as skipped', async () => {
    const res = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } });
    expect(res.status).toBe('ok');
    expect(res.scan!.skipped).toEqual([
      { path: '.env.local', reason: 'denied' },
      { path: 'etc-link', reason: 'outside_root' },
      { path: 'leak.txt', reason: 'outside_root' },
    ]);
    expect(res.scan!.files.read).toBe(2);
    const json = JSON.stringify(res);
    expect(json).not.toContain(ENV_SECRET);
    expect(json).not.toContain(OUTSIDE_SECRET);
  });

  it('keeps both secrets out of SQLite, including the files table', () => {
    closeEngine(engine);
    const db = openDb(path.join(out, 'store.sqlite'));
    const files = db.prepare('SELECT path FROM files').all() as { path: string }[];
    expect(files.map((f) => f.path).sort()).toEqual(['package-lock.json', 'package.json']);
    db.close();
    for (const name of readdirSync(out).filter((n) => n.startsWith('store.sqlite'))) {
      const bytes = readFileSync(path.join(out, name)).toString('latin1');
      expect(bytes).not.toContain(ENV_SECRET);
      expect(bytes).not.toContain(OUTSIDE_SECRET);
    }
    engine = createEngine({ out });
  });

  it('a direct read of either path still throws', () => {
    expectPermission(() => readText(resolveInside(repo, '.env.local')), 'denied');
    expectPermission(() => resolveInside(repo, 'leak.txt'), 'outside_root');
  });
});
