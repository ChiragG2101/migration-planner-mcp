// INV-1, INV-2 (C3): safeWrite writes only under --out and never inside a
// registered repo. The repo sits inside --out on purpose, so only the
// registered-repo check can stop the write into it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initLevel } from '../../src/security/level.js';
import { openOutDir, registerRepoRoot, type OutWriter } from '../../src/security/safeWrite.js';
import { expectPermission, tmpDir, writeTree } from '../helpers.js';

let base: string;
let work: string;
let app: string;
let writer: OutWriter;

beforeAll(() => {
  initLevel(0);
  base = tmpDir();
  work = path.join(base, 'work');
  app = path.join(work, 'app');
  writeTree(app, { 'package.json': '{}' });
  registerRepoRoot(app);
  writer = openOutDir(work);
});

describe('safeWrite', () => {
  it('writes under the output folder', () => {
    const sp = writer.writeFile('runs/r1/scan.json', '{}', { level: 0 });
    expect(readFileSync(sp.abs, 'utf8')).toBe('{}');
  });

  it('refuses ../ out of the output folder', () => {
    expectPermission(() => writer.writeFile('../x.txt', 'x', { level: 0 }), 'write_outside_out');
    expect(existsSync(path.join(base, 'x.txt'))).toBe(false);
  });

  it('refuses an absolute path outside the output folder', () => {
    expectPermission(() => writer.writeFile(path.join(base, 'abs.txt'), 'x', { level: 0 }), 'write_outside_out');
    expectPermission(() => writer.writeFile('/etc/mp-test.txt', 'x', { level: 0 }), 'write_outside_out');
  });

  it('refuses a write into the repo root even though the repo is inside --out', () => {
    expectPermission(() => writer.writeFile('app/evil.txt', 'x', { level: 0 }), 'write_inside_repo');
    expectPermission(() => writer.writeFile(path.join(app, 'evil.txt'), 'x', { level: 0 }), 'write_inside_repo');
    expectPermission(() => writer.mkdir('app/newdir', { level: 0 }), 'write_inside_repo');
    expect(existsSync(path.join(app, 'evil.txt'))).toBe(false);
    expect(existsSync(path.join(app, 'newdir'))).toBe(false);
  });

  it('refuses a write that declares a level above the process level', () => {
    expectPermission(() => writer.writeFile('l1.txt', 'x', { level: 1 }), 'level');
    expectPermission(() => writer.mkdir('l1dir', { level: 1 }), 'level');
    expect(existsSync(path.join(work, 'l1.txt'))).toBe(false);
    expect(existsSync(path.join(work, 'l1dir'))).toBe(false);
  });

  it('refuses an output folder inside a registered repo', () => {
    expectPermission(() => openOutDir(path.join(app, '.migration-planner')), 'out_inside_repo');
    expect(existsSync(path.join(app, '.migration-planner'))).toBe(false);
  });
});
