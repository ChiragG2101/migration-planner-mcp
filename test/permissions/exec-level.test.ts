// INV-3, INV-51 (C3, C5): exec functions require level 1; at level 0 they throw.
// Removing assertLevel(1) from any exec wrapper must fail this test.
// Note: vi.resetModules() creates a new module instance, so instanceof checks
// against the outer PermissionError class fail. We check .name and .code instead.
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInside } from '../../src/security/pathBoundary.js';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mp-exec-test-'));
  mkdirSync(path.join(tmpRoot, 'sandbox'), { recursive: true });
});
afterEach(() => {
  vi.resetModules();
});

function catchSync(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

async function makeExecAtLevel(level: 0 | 1) {
  vi.resetModules();
  const { initLevel } = await import('../../src/security/level.js');
  initLevel(level);
  const exec = await import('../../src/security/exec.js');
  return exec;
}

describe('execCheck at level 0', () => {
  it('throws PermissionError with code "level"', async () => {
    const exec = await makeExecAtLevel(0);
    const cwd = resolveInside(tmpRoot, 'sandbox', null);
    const cfg = { name: 'test', argv: ['echo', 'hi'], timeout_ms: 5000 };
    const e = catchSync(() => exec.execCheck(cfg, cwd, path.join(tmpRoot, 'sandbox')));
    expect((e as { name?: string }).name).toBe('PermissionError');
    expect((e as { code?: string }).code).toBe('level');
  });
});

describe('execInstall at level 0', () => {
  it('throws PermissionError with code "level"', async () => {
    const exec = await makeExecAtLevel(0);
    const cwd = resolveInside(tmpRoot, 'sandbox', null);
    const cfg = { argv: ['echo', 'hi'], timeout_ms: 5000 };
    const e = catchSync(() => exec.execInstall(cfg, cwd, path.join(tmpRoot, 'sandbox')));
    expect((e as { name?: string }).name).toBe('PermissionError');
    expect((e as { code?: string }).code).toBe('level');
  });
});

describe('execGit at level 0', () => {
  it('throws PermissionError with code "level"', async () => {
    const exec = await makeExecAtLevel(0);
    const cwd = resolveInside(tmpRoot, 'sandbox', null);
    const e = catchSync(() => exec.execGit(['git', 'status'], cwd, path.join(tmpRoot, 'sandbox')));
    expect((e as { name?: string }).name).toBe('PermissionError');
    expect((e as { code?: string }).code).toBe('level');
  });
});

describe('execGit with disallowed subcommand', () => {
  it('throws PermissionError with code "unlisted_argv" at level 1', async () => {
    const exec = await makeExecAtLevel(1);
    const cwd = resolveInside(tmpRoot, 'sandbox', null);
    // 'rm' is not in the allowed git subcommand set
    const e = catchSync(() => exec.execGit(['git', 'rm', '-rf', '.'], cwd, path.join(tmpRoot, 'sandbox')));
    expect((e as { name?: string }).name).toBe('PermissionError');
    expect((e as { code?: string }).code).toBe('unlisted_argv');
  });
});

describe('execCheck outside sandbox', () => {
  it('throws exec_outside_sandbox when cwd is outside the sandbox root', async () => {
    const exec = await makeExecAtLevel(1);
    // cwd is the tmpRoot itself, not inside tmpRoot/sandbox
    const cwd = resolveInside(tmpRoot, '.', null);
    const cfg = { name: 'test', argv: ['echo', 'hi'], timeout_ms: 5000 };
    const e = catchSync(() => exec.execCheck(cfg, cwd, path.join(tmpRoot, 'sandbox')));
    expect((e as { name?: string }).name).toBe('PermissionError');
    expect((e as { code?: string }).code).toBe('exec_outside_sandbox');
  });
});

describe('isSandboxPath', () => {
  it('returns true for a path inside the sandbox', async () => {
    const exec = await makeExecAtLevel(0);
    const sandboxRoot = path.join(tmpRoot, 'sandbox');
    mkdirSync(sandboxRoot, { recursive: true });
    const cwd = resolveInside(tmpRoot, 'sandbox', null);
    expect(exec.isSandboxPath(cwd, sandboxRoot)).toBe(true);
  });

  it('returns false for a path outside the sandbox', async () => {
    const exec = await makeExecAtLevel(0);
    const sandboxRoot = path.join(tmpRoot, 'sandbox');
    mkdirSync(sandboxRoot, { recursive: true });
    const cwd = resolveInside(tmpRoot, '.', null);
    expect(exec.isSandboxPath(cwd, sandboxRoot)).toBe(false);
  });
});
