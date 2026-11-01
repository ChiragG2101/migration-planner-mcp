// The child's HOME is always a fresh temp dir (INV-7, D62, C3/C6). A real
// HOME holds dotfiles (~/.npmrc, ~/.netrc, ~/.gitconfig) that can carry tokens,
// so neither the parent's HOME, a --pass-env HOME nor the engine's own extra
// values may reach a spawned command. These spawn through the real exec.ts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
let fakeHome: string;
let sandboxRoot: string;
let savedHome: string | undefined;

const TEMP_HOME_PREFIX = () => path.join(realpathSync(os.tmpdir()), 'mp-exec-home-');

const printHome = {
  name: 'print-home',
  argv: ['node', '-e', 'process.stdout.write(process.env.HOME ?? "<unset>")'],
  timeout_ms: 20000,
};

async function atLevel1() {
  vi.resetModules();
  const { initLevel } = await import('../../src/security/level.js');
  initLevel(1);
  return {
    exec: await import('../../src/security/exec.js'),
    pathBoundary: await import('../../src/security/pathBoundary.js'),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mp-home-'));
  // A stand-in for the user's real home, with a dotfile that must never be seen.
  fakeHome = path.join(tmp, 'real-home');
  mkdirSync(fakeHome);
  writeFileSync(path.join(fakeHome, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret_should_not_leak\n');
  sandboxRoot = path.join(tmp, 'out', 'run', 'sandbox');
  mkdirSync(sandboxRoot, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  vi.resetModules();
});

function expectTempHome(childHome: string): void {
  expect(childHome).not.toBe(fakeHome);
  expect(childHome.startsWith(TEMP_HOME_PREFIX())).toBe(true);
  // Fresh: no dotfiles in it.
  expect(readdirSync(childHome)).toEqual([]);
}

describe('exec-home-is-temp', () => {
  it('a check sees a fresh temp HOME, not the parent HOME', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    const res = exec.execCheck(printHome, cwd, sandboxRoot);
    expect(res.exit_code).toBe(0);
    expectTempHome(res.stdout);
  });

  it('--pass-env HOME cannot bring the parent HOME back', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    const res = exec.execCheck(printHome, cwd, sandboxRoot, ['HOME']);
    expect(res.exit_code).toBe(0);
    expectTempHome(res.stdout);
  });

  it('each command gets its own fresh HOME', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    const a = exec.execCheck(printHome, cwd, sandboxRoot).stdout;
    const b = exec.execCheck(printHome, cwd, sandboxRoot).stdout;
    expectTempHome(a);
    expectTempHome(b);
    expect(a).not.toBe(b);
  });

  it("the engine's extra env cannot replace HOME on a git operation", async () => {
    const { exec, pathBoundary } = await atLevel1();
    // A home whose .gitconfig switches `git status` to short format. If the
    // child read it, the untracked file would print as "?? untracked.txt".
    const gitHome = path.join(tmp, 'git-home');
    mkdirSync(gitHome);
    writeFileSync(path.join(gitHome, '.gitconfig'), '[status]\n\tshort = true\n');
    execFileSync('git', ['init', '-q'], { cwd: sandboxRoot, stdio: 'pipe' });
    writeFileSync(path.join(sandboxRoot, 'untracked.txt'), 'x\n');
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    const res = exec.execGit(['git', 'status'], cwd, sandboxRoot, 20000, { HOME: gitHome });
    expect(res.exit_code).toBe(0);
    expect(res.stdout).toContain('untracked.txt');
    expect(res.stdout).not.toContain('?? untracked.txt');
  });
});
