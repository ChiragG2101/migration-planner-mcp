// INV-2, INV-3 (C3, C5): only src/security/exec.ts may spawn a process, and in
// M1 it refuses at every level.
import { describe, expect, it, vi } from 'vitest';
import { PermissionError } from '../../src/security/errors.js';
import { allImports, lintAs } from '../static.js';

const spawnModules = new Set(['child_process', 'node:child_process', 'execa', 'worker_threads', 'node:worker_threads']);
const execFile = 'src/security/exec.ts';

describe('single spawn point', () => {
  it('no file under src/ except exec.ts imports a process-spawning module', () => {
    const offenders = allImports().filter((u) => spawnModules.has(u.module) && u.file !== execFile);
    expect(offenders).toEqual([]);
  });

  it('no file under src/ uses a non-literal dynamic import or require', () => {
    expect(allImports().filter((u) => u.module === '<non-literal>')).toEqual([]);
  });

  it('the lint rule fails on a planted child_process import', async () => {
    expect(await lintAs('src/core/planted.ts', "import { spawn } from 'node:child_process';\nspawn('ls');\n")).not.toEqual([]);
    expect(await lintAs('src/security/planted.ts', "import { execSync } from 'child_process';\nexecSync('ls');\n")).not.toEqual([]);
    expect(await lintAs('src/store/planted.ts', "import { Worker } from 'node:worker_threads';\nnew Worker('x');\n")).not.toEqual([]);
  });

  it('the lint rule allows exec.ts itself', async () => {
    expect(await lintAs(execFile, "import { spawn } from 'node:child_process';\nexport const s = spawn;\n")).toEqual([]);
  });
});

describe('exec in M1', () => {
  it.each([0, 1] as const)('throws "execution not available" at level %i', async (level) => {
    vi.resetModules();
    const { initLevel } = await import('../../src/security/level.js');
    const { exec } = await import('../../src/security/exec.js');
    const errors = await import('../../src/security/errors.js');
    initLevel(level);
    let caught: unknown;
    try {
      exec({ argv: ['echo', 'hi'], cwd: '/tmp' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.PermissionError);
    expect((caught as PermissionError).code).toBe('exec_unavailable');
    expect((caught as PermissionError).message).toBe('execution not available');
  });
});
