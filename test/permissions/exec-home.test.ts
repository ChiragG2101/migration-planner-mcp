// The child's HOME is always a fresh temp dir (INV-7, D62, C3/C6). A real
// HOME holds dotfiles (~/.npmrc, ~/.netrc, ~/.gitconfig) that can carry tokens,
// so neither the parent's HOME, a --pass-env HOME nor the engine's own extra
// values may reach a spawned command. The temp HOME is removed when the
// command ends, even on a timeout. These spawn through the real exec.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
let fakeHome: string;
let sandboxRoot: string;
let savedHome: string | undefined;

const TEMP_HOME_PREFIX = () => path.join(realpathSync(os.tmpdir()), 'mp-exec-home-');

// The child reports its HOME and what is in it, since the dir is gone by the
// time the parent could look.
const printHome = {
  name: 'print-home',
  argv: [
    'node',
    '-e',
    'const h = process.env.HOME ?? ""; process.stdout.write(JSON.stringify({ home: h, entries: require("fs").readdirSync(h) }))',
  ],
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
  rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

/** Checks the child's report and returns the HOME it saw. */
function expectTempHome(stdout: string): string {
  const { home, entries } = JSON.parse(stdout) as { home: string; entries: string[] };
  expect(home).not.toBe(fakeHome);
  expect(home.startsWith(TEMP_HOME_PREFIX())).toBe(true);
  // Fresh: no dotfiles in it.
  expect(entries).toEqual([]);
  return home;
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
    const a = expectTempHome(exec.execCheck(printHome, cwd, sandboxRoot).stdout);
    const b = expectTempHome(exec.execCheck(printHome, cwd, sandboxRoot).stdout);
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

describe('exec-home-removed', () => {
  it('the temp HOME is removed after the command, with what the command wrote in it', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    // Like an install filling ~/.npm: write into HOME, then report it.
    const fillHome = {
      name: 'fill-home',
      argv: [
        'node',
        '-e',
        'const fs = require("fs"); const h = process.env.HOME; fs.mkdirSync(h + "/.npm/_cacache", { recursive: true }); fs.writeFileSync(h + "/.npm/_cacache/x", "y"); process.stdout.write(h)',
      ],
      timeout_ms: 20000,
    };
    const res = exec.execCheck(fillHome, cwd, sandboxRoot);
    expect(res.exit_code).toBe(0);
    expect(res.stdout.startsWith(TEMP_HOME_PREFIX())).toBe(true);
    expect(existsSync(res.stdout)).toBe(false);
  });

  it('the temp HOME is removed when the command times out', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    const hang = {
      name: 'hang',
      argv: ['node', '-e', 'process.stdout.write(process.env.HOME); for (;;) {}'],
      timeout_ms: 1500,
    };
    const res = exec.execCheck(hang, cwd, sandboxRoot);
    expect(res.timed_out).toBe(true);
    expect(res.stdout.startsWith(TEMP_HOME_PREFIX())).toBe(true);
    expect(existsSync(res.stdout)).toBe(false);
  });

  it('the temp HOME is removed when the spawn itself throws', async () => {
    // Record the dir exec.ts makes, since the child never runs to report it.
    const made: string[] = [];
    vi.resetModules();
    vi.doMock('../../src/security/safeWrite.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/security/safeWrite.js')>();
      return {
        ...real,
        mkdtempSandbox: (prefix: string) => {
          const d = real.mkdtempSandbox(prefix);
          made.push(d);
          return d;
        },
      };
    });
    try {
      const { initLevel } = await import('../../src/security/level.js');
      initLevel(1);
      const exec = await import('../../src/security/exec.js');
      const pathBoundary = await import('../../src/security/pathBoundary.js');
      const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
      // A NUL byte in an argument makes spawnSync throw before any child starts.
      const bad = { name: 'bad', argv: ['node', 'a\u0000b'], timeout_ms: 20000 };
      expect(() => exec.execCheck(bad, cwd, sandboxRoot)).toThrow(/null bytes/);
      expect(made).toHaveLength(1);
      expect(made[0]!.startsWith(TEMP_HOME_PREFIX())).toBe(true);
      expect(existsSync(made[0]!)).toBe(false);
    } finally {
      vi.doUnmock('../../src/security/safeWrite.js');
    }
  });

  it('a read-only dir the command leaves in HOME neither loses the result nor stays behind', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    // Like Go's module cache: a dir with a file in it, then made read-only.
    const readOnly = {
      name: 'read-only',
      argv: [
        'node',
        '-e',
        'const fs = require("fs"); const h = process.env.HOME; fs.mkdirSync(h + "/ro"); fs.writeFileSync(h + "/ro/f", "x"); fs.chmodSync(h + "/ro", 0o555); process.stdout.write("done:" + h)',
      ],
      timeout_ms: 20000,
    };
    const res = exec.execCheck(readOnly, cwd, sandboxRoot);
    expect(res.exit_code).toBe(0);
    expect(res.stdout.startsWith(`done:${TEMP_HOME_PREFIX()}`)).toBe(true);
    expect(existsSync(res.stdout.slice('done:'.length))).toBe(false);
  });

  /** Loads exec.ts at L1 with safeWrite's rmSandbox replaced by `rm`. */
  async function withRmSandbox(rm: (abs: string) => void) {
    vi.resetModules();
    vi.doMock('../../src/security/safeWrite.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/security/safeWrite.js')>()),
      rmSandbox: rm,
    }));
    const { initLevel } = await import('../../src/security/level.js');
    initLevel(1);
    const exec = await import('../../src/security/exec.js');
    const pathBoundary = await import('../../src/security/pathBoundary.js');
    return { exec, cwd: pathBoundary.resolveInside(sandboxRoot, '.', null) };
  }

  it('a removal that fails is reported on stderr and the command result is kept', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { exec, cwd } = await withRmSandbox(() => { throw new Error('EBUSY: resource busy'); });
      const echo = { name: 'echo', argv: ['node', '-e', 'process.stdout.write("kept")'], timeout_ms: 20000 };
      const res = exec.execCheck(echo, cwd, sandboxRoot);
      expect(res.exit_code).toBe(0);
      expect(res.stdout).toBe('kept');
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('could not remove the temp HOME') && l.includes('EBUSY: resource busy'))).toBe(true);
    } finally {
      warn.mockRestore();
      vi.doUnmock('../../src/security/safeWrite.js');
    }
  });

  it('a boundary refusal from the removal still throws', async () => {
    try {
      // The class must come from the module copy exec.ts loads, after the reset.
      const errors: { PE?: typeof import('../../src/security/errors.js').PermissionError } = {};
      const { exec, cwd } = await withRmSandbox((abs) => {
        throw new errors.PE!('write_inside_repo', `rm inside the repo refused: ${abs}`);
      });
      errors.PE = (await import('../../src/security/errors.js')).PermissionError;
      const echo = { name: 'echo', argv: ['node', '-e', 'process.stdout.write("x")'], timeout_ms: 20000 };
      let caught: unknown;
      try { exec.execCheck(echo, cwd, sandboxRoot); } catch (e) { caught = e; }
      expect((caught as { code?: string } | undefined)?.code).toBe('write_inside_repo');
    } finally {
      vi.doUnmock('../../src/security/safeWrite.js');
    }
  });
});
