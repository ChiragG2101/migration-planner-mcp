// Exec/sandbox permissions (M8, C3/C5/C9). These run real git and node in a
// clone sandbox under a temp --out, so they exercise the actual spawn point.
// Each test maps to a named check in the milestone plan.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'l1-node');

let tmp: string;
let repo: string;
let out: string;

/** A committed git repo cloned from the node fixture. Returns its HEAD-clean path. */
function makeRepo(): string {
  const r = path.join(tmp, 'repo');
  cpSync(FIXTURE, r, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: r, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return r;
}

async function atLevel1() {
  vi.resetModules();
  const { initLevel } = await import('../../src/security/level.js');
  initLevel(1);
  return {
    exec: await import('../../src/security/exec.js'),
    sandbox: await import('../../src/verify/sandbox.js'),
    pathBoundary: await import('../../src/security/pathBoundary.js'),
    safeWrite: await import('../../src/security/safeWrite.js'),
  };
}

function catchSync(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mp-sbx-'));
  repo = makeRepo();
  out = path.join(tmp, 'out');
  mkdirSync(out, { recursive: true });
});
afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// unlisted-codemod-refused
// ---------------------------------------------------------------------------

describe('unlisted-codemod-refused', () => {
  it('an unknown codemod ID has no registry entry', async () => {
    const { codemods } = { codemods: await import('../../src/verify/codemods.js') };
    expect(codemods.getCodemodEntry('next-codemod:does-not-exist')).toBeUndefined();
    expect(codemods.getCodemodEntry('rm -rf /')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unlisted-argv-refused (extra argument appended to a known codemod)
// ---------------------------------------------------------------------------

describe('unlisted-argv-refused', () => {
  it('a codemod argv that does not match the registry entry is refused', async () => {
    const { exec, pathBoundary } = await atLevel1();
    const codemods = await import('../../src/verify/codemods.js');
    const entry = codemods.getCodemodEntry('next-codemod:new-link')!;
    const sandboxRoot = path.join(out, 'run', 'sandbox');
    mkdirSync(sandboxRoot, { recursive: true });
    const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
    // Swap the pinned package for an attacker-controlled one.
    const tampered = ['npx', 'evil@1.0.0', 'new-link', sandboxRoot];
    const e = catchSync(() => exec.execCodemod(entry, tampered, cwd, sandboxRoot));
    expect((e as { code?: string }).code).toBe('unlisted_argv');
  });
});

// ---------------------------------------------------------------------------
// env-scrubbed
// ---------------------------------------------------------------------------

describe('env-scrubbed', () => {
  it('a check cannot see GITHUB_TOKEN or AWS_SECRET_ACCESS_KEY from the parent', async () => {
    process.env.GITHUB_TOKEN = 'ghp_secret_should_not_leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret_should_not_leak';
    try {
      const { exec, pathBoundary } = await atLevel1();
      const sandboxRoot = path.join(out, 'run', 'sandbox');
      mkdirSync(sandboxRoot, { recursive: true });
      const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
      // node prints the whole environment; neither secret must appear.
      const cfg = {
        name: 'printenv',
        argv: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
        timeout_ms: 20000,
      };
      const res = exec.execCheck(cfg, cwd, sandboxRoot);
      expect(res.exit_code).toBe(0);
      expect(res.stdout).not.toContain('ghp_secret_should_not_leak');
      expect(res.stdout).not.toContain('aws_secret_should_not_leak');
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it('an allowed name passed with passEnv is visible, others are not', async () => {
    process.env.MY_ALLOWED = 'ok-value';
    process.env.MY_BLOCKED = 'blocked-value';
    try {
      const { exec, pathBoundary } = await atLevel1();
      const sandboxRoot = path.join(out, 'run', 'sandbox');
      mkdirSync(sandboxRoot, { recursive: true });
      const cwd = pathBoundary.resolveInside(sandboxRoot, '.', null);
      const cfg = {
        name: 'printenv',
        argv: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'],
        timeout_ms: 20000,
      };
      const res = exec.execCheck(cfg, cwd, sandboxRoot, ['MY_ALLOWED']);
      expect(res.stdout).toContain('ok-value');
      expect(res.stdout).not.toContain('blocked-value');
    } finally {
      delete process.env.MY_ALLOWED;
      delete process.env.MY_BLOCKED;
    }
  });
});

// ---------------------------------------------------------------------------
// dirty-tree-refused
// ---------------------------------------------------------------------------

describe('dirty-tree-refused', () => {
  it('a dirty source tree refuses with the verifies-HEAD message', async () => {
    const { sandbox, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    // Make the tree dirty.
    writeFileSync(path.join(repo, 'add.js'), 'export function add(a,b){return a+b+1;}\n');
    const e = catchSync(() => sandbox.createSandbox(repo, out, 'run'));
    expect((e as { code?: string }).code).toBe('dirty_tree');
    expect((e as Error).message).toContain('HEAD');
  });
});

// ---------------------------------------------------------------------------
// source-repo-untouched + source-hooks-not-run (clone + git ops)
// ---------------------------------------------------------------------------

describe('source-repo-untouched and hooks-not-run', () => {
  it('cloning and tagging never writes the source repo and never runs its hooks', async () => {
    const { sandbox, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);

    // Plant a post-checkout hook that would create a marker if it ran.
    const hooksDir = path.join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const marker = path.join(tmp, 'HOOK_RAN');
    const hookPath = path.join(hooksDir, 'post-checkout');
    writeFileSync(hookPath, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hookPath, 0o755);

    // Hash the source index before.
    const indexBefore = readFileSync(path.join(repo, '.git', 'index'));

    const sb = sandbox.createSandbox(repo, out, 'run');
    sandbox.tagStageStart(sb, 'stage-1');

    // The source index is byte-identical; no hook marker exists.
    const indexAfter = readFileSync(path.join(repo, '.git', 'index'));
    expect(indexAfter.equals(indexBefore)).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The clone exists and reflects HEAD.
    expect(existsSync(path.join(sb.root, 'add.js'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patch-escape-refused
// ---------------------------------------------------------------------------

describe('patch-escape-refused', () => {
  it('a patch touching a path outside the sandbox or on the deny list is refused', async () => {
    const { sandbox, safeWrite } = await atLevel1();
    const loop = await import('../../src/verify/loop.js');
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');

    // Absolute / parent-escaping path.
    expect(catchSync(() => loop.assertPatchPathsSafe(sb, ['../outside.txt'])))
      .toHaveProperty('code', 'patch_escape');
    expect(catchSync(() => loop.assertPatchPathsSafe(sb, ['/etc/passwd'])))
      .toHaveProperty('code', 'patch_escape');
    // Deny-listed file.
    expect(catchSync(() => loop.assertPatchPathsSafe(sb, ['.env'])))
      .toHaveProperty('code', 'patch_escape');
    // A normal in-tree path is fine.
    expect(catchSync(() => loop.assertPatchPathsSafe(sb, ['add.js']))).toBeNull();
  });
});
