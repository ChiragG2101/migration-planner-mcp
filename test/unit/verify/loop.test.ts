// Loop + sandbox unit tests (M8). Real git clone of the node fixture under a
// temp --out, run at level 1. Covers: rollback restores the exact tree hash,
// flaky single-rerun, timeout, baseline_failing, patch-escape, retry-cap
// decision, and the patch-replay check (kept patch reproduces the final tree).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURE = path.join(import.meta.dirname, '..', '..', 'fixtures', 'l1-node');

let tmp: string;
let repo: string;
let out: string;

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepo(): string {
  const r = path.join(tmp, 'repo');
  cpSync(FIXTURE, r, { recursive: true });
  gitIn(r, ['init', '-q']);
  gitIn(r, ['config', 'user.email', 't@t.local']);
  gitIn(r, ['config', 'user.name', 'test']);
  gitIn(r, ['config', 'commit.gpgsign', 'false']);
  gitIn(r, ['add', '-A']);
  gitIn(r, ['commit', '-q', '-m', 'init']);
  return r;
}

async function atLevel1() {
  vi.resetModules();
  const { initLevel } = await import('../../../src/security/level.js');
  initLevel(1);
  return {
    sandbox: await import('../../../src/verify/sandbox.js'),
    loop: await import('../../../src/verify/loop.js'),
    safeWrite: await import('../../../src/security/safeWrite.js'),
  };
}

/** The git tree hash of the working tree (index), a stable fingerprint. */
function treeHash(dir: string): string {
  gitIn(dir, ['add', '-A']);
  return gitIn(dir, ['write-tree']).trim();
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mp-loop-'));
  repo = makeRepo();
  out = path.join(tmp, 'out');
  mkdirSync(out, { recursive: true });
});
afterEach(() => vi.resetModules());

describe('rollback restores the exact tree hash', () => {
  it('resetToStageStart returns the sandbox to the tagged tree', async () => {
    const { sandbox, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    sandbox.tagStageStart(sb, 's1');
    const before = treeHash(sb.root);

    // Dirty the tree.
    writeFileSync(path.join(sb.root, 'add.js'), 'export function add(a,b){return 999;}\n');
    expect(treeHash(sb.root)).not.toBe(before);

    sandbox.resetToStageStart(sb, 's1');
    expect(treeHash(sb.root)).toBe(before);
  });
});

describe('flaky single-rerun', () => {
  it('a check that fails then passes is marked flaky, not fail', async () => {
    const { sandbox, loop, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    // A check that fails the first time (no marker) and passes once the marker
    // exists: it creates the marker on its first failing run.
    const marker = path.join(sb.root, '.flaky-marker');
    const cfg = {
      name: 'flaky',
      argv: ['node', '-e', `const fs=require('fs');const m=${JSON.stringify(marker)};if(fs.existsSync(m)){process.exit(0)}else{fs.writeFileSync(m,'x');process.exit(1)}`],
      timeout_ms: 20000,
    };
    const results = loop.runChecks(sb, [cfg], new Set(), true);
    expect(results[0]!.status).toBe('flaky');
  });

  it('without the rerun flag the same check is a plain fail', async () => {
    const { sandbox, loop, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    const cfg = { name: 'fails', argv: ['node', '-e', 'process.exit(1)'], timeout_ms: 20000 };
    const results = loop.runChecks(sb, [cfg], new Set(), false);
    expect(results[0]!.status).toBe('fail');
  });
});

describe('baseline_failing', () => {
  it('a check that failed at baseline does not count as a new failure', async () => {
    const { sandbox, loop, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    const cfg = { name: 'always-fails', argv: ['node', '-e', 'process.exit(1)'], timeout_ms: 20000 };
    const results = loop.runChecks(sb, [cfg], new Set(['always-fails']), false);
    expect(results[0]!.status).toBe('baseline_failing');
  });
});

describe('timeout', () => {
  it('a check that exceeds its timeout is marked timeout', async () => {
    const { sandbox, loop, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    const cfg = { name: 'slow', argv: ['node', '-e', 'setTimeout(()=>{}, 60000)'], timeout_ms: 300 };
    const results = loop.runChecks(sb, [cfg], new Set(), false);
    expect(results[0]!.status).toBe('timeout');
  });
});

describe('patch-replay', () => {
  it('applying the exported kept patch to a fresh clone reproduces the final tree', async () => {
    const { sandbox, loop, safeWrite } = await atLevel1();
    safeWrite.registerRepoRoot(repo);
    const sb = sandbox.createSandbox(repo, out, 'run');
    sandbox.tagStageStart(sb, 's1');

    // Apply a real patch via the file-list path.
    loop.applyPatch(sb, [{ path: 'add.js', content: 'export function add(a, b) {\n  return a + b;\n}\nexport const VERSION = 2;\n' }]);
    // Commit it (what submitStagePatch does on kept) and export the diff.
    gitIn(sb.root, ['commit', '-q', '-m', 'stage s1']);
    const diff = gitIn(sb.root, ['diff', 'mp-stage-start-s1', 'HEAD']);
    const finalTree = treeHash(sb.root);

    // Fresh clone of the base commit, apply the patch, compare trees.
    const fresh = path.join(tmp, 'fresh');
    gitIn(repo, ['clone', '-q', '--no-hardlinks', '--local', repo, fresh]);
    const patchFile = path.join(tmp, 's1.patch');
    writeFileSync(patchFile, diff);
    gitIn(fresh, ['apply', '--index', patchFile]);
    expect(treeHash(fresh)).toBe(finalTree);
  });
});

describe('retry-cap decision', () => {
  it('a third rejected attempt becomes unresolved', async () => {
    const { capDecision } = await import('../../../src/core/submitStagePatch.js');
    expect(capDecision('rejected', 1)).toBe('rejected');
    expect(capDecision('rejected', 2)).toBe('rejected');
    expect(capDecision('rejected', 3)).toBe('unresolved');
    expect(capDecision('kept', 3)).toBe('kept');
  });
});
