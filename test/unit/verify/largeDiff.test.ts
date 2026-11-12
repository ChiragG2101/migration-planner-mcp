// A diff larger than the spawn point's 256 KiB output cap (a lockfile change)
// is recorded whole, never cut to its tail (D64). Runs real git in a clone
// sandbox under a temp --out, through the engine and through the loop.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  closeEngine,
  createEngine,
  findUsages,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  submitStagePatch,
  validatePlan,
  verifyStage,
} from '../../../src/core/index.js';
import { BUMP_STAGE_ID } from '../../../src/pipeline/aggregate.js';
import { copyFixture, tmpDir } from '../../helpers.js';

const CAP = 256 * 1024;

/** About 400 KB of lockfile-like text with a marker on its first and last line. */
function bigLock(tag: string): string {
  const lines = [`# FIRST-LINE-${tag}`];
  for (let i = 0; lines.join('\n').length < CAP + 150 * 1024; i++) {
    lines.push(`"pkg-${i}@^1.0.0":\n  version "1.0.${i}"\n  resolved "https://registry.example/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz#${tag}"`);
  }
  lines.push(`# LAST-LINE-${tag}`);
  return `${lines.join('\n')}\n`;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function gitRepo(): string {
  const repo = copyFixture('next-clean');
  writeFileSync(path.join(repo, 'yarn.lock'), bigLock('old'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.local']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function expectWhole(diff: string): void {
  expect(diff.length).toBeGreaterThan(CAP);
  expect(diff.startsWith('diff --git a/yarn.lock b/yarn.lock\n')).toBe(true);
  expect(diff).toContain('+# FIRST-LINE-new');
  expect(diff).toContain('+# LAST-LINE-new');
}

describe('large-diff-whole', () => {
  it('a kept patch bigger than the output cap is exported whole and reproduces the tree', async () => {
    const repo = gitRepo();
    const out = tmpDir();
    const engine = createEngine({ out, level: 1, checks: [{ name: 'ok', argv: ['node', '-e', 'process.exit(0)'], timeout_ms: 20_000 }] });
    try {
      const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
      const id = scan.run!.run_id;
      await findUsages(engine, { run_id: id });
      await proposeScope(engine, { run_id: id });
      await setScope(engine, { run_id: id, answers: {} });
      await mergeFindings(engine, { run_id: id });
      expect((await validatePlan(engine, { run_id: id })).status).toBe('passed');

      await verifyStage(engine, { run_id: id, stage_id: BUMP_STAGE_ID });
      const res = await submitStagePatch(engine, { run_id: id, stage_id: BUMP_STAGE_ID, patch: [{ path: 'yarn.lock', content: bigLock('new') }] });
      expect(res.decision).toBe('kept');
      const patch = readFileSync(path.join(out, res.patch_path!), 'utf8');
      expectWhole(patch);

      // The exported patch applies to a fresh copy of the source and gives the new file.
      const fresh = path.join(tmpDir(), 'fresh');
      git(repo, ['clone', '-q', '--no-hardlinks', '--local', repo, fresh]);
      const patchFile = path.join(tmpDir(), 'kept.patch');
      writeFileSync(patchFile, patch);
      git(fresh, ['apply', '--index', patchFile]);
      expect(readFileSync(path.join(fresh, 'yarn.lock'), 'utf8')).toBe(bigLock('new'));
    } finally {
      closeEngine(engine);
    }
  });

  it("the loop's own diffs (applied patch, prepared stage) are whole", async () => {
    vi.resetModules();
    const { initLevel } = await import('../../../src/security/level.js');
    initLevel(1);
    const sandbox = await import('../../../src/verify/sandbox.js');
    const loop = await import('../../../src/verify/loop.js');
    const safeWrite = await import('../../../src/security/safeWrite.js');
    const repo = gitRepo();
    safeWrite.registerRepoRoot(repo);
    const out = path.join(tmpDir(), 'out');
    mkdirSync(out, { recursive: true });
    const sb = sandbox.createSandbox(repo, out, 'run');

    // The diff applyPatch records (it is hashed and stored with the attempt).
    expectWhole(loop.applyPatch(sb, [{ path: 'yarn.lock', content: bigLock('new') }]));
    loop.resetSandbox(sb);

    // The working-tree diff prepareStage reads after the codemods (none here).
    writeFileSync(path.join(sb.root, 'yarn.lock'), bigLock('new'));
    expectWhole(loop.prepareStage(sb, []).codemodDiff);

    // A unified diff from the agent: the diff recorded after `git apply`.
    const unified = execFileSync('git', ['diff'], { cwd: sb.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    loop.resetSandbox(sb);
    expectWhole(loop.applyPatch(sb, unified));

    // The temp diff files are removed after each read.
    expect(readdirSync(path.dirname(sb.root)).filter((f) => f.startsWith('diff-'))).toEqual([]);
    vi.resetModules();
  });
});
