// M9 at L1, end to end through the engine on a small git repo: a stage whose
// patch gate 7 holds for review goes to "Review first" with the gate 7 reason;
// emit writes verify_report.json, and run_report.md's verify section matches it
// and the exec events; a time budget cuts the stages not settled yet; the
// source repo hash is unchanged throughout. Runs real git and node in a clone
// sandbox under a temp --out.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  emitPlan,
  findUsages,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  submitStagePatch,
  validatePlan,
  verifyStage,
  type Engine,
} from '../../../src/core/index.js';
import { openSession } from '../../../src/core/engine.js';
import { BUMP_STAGE_ID } from '../../../src/pipeline/aggregate.js';
import type { VerifyReport } from '../../../src/schema/verify.js';
import { listEvents } from '../../../src/store/events.js';
import { repoHash } from '../../../scripts/repo-hash.js';
import { copyFixture, tmpDir } from '../../helpers.js';

const TEST_FILE = `import { it, expect } from 'vitest';
it('one', () => { expect(1).toBe(1); });
it('two', () => { expect(2).toBe(2); });
`;

function gitRepo(): string {
  const repo = copyFixture('next-clean');
  writeFileSync(path.join(repo, 'app', 'a.test.ts'), TEST_FILE);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return repo;
}

const checks = [{ name: 'ok', argv: ['node', '-e', 'process.exit(0)'], timeout_ms: 20_000 }];

async function planned(engine: Engine, repo: string): Promise<string> {
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  await mergeFindings(engine, { run_id: id });
  expect((await validatePlan(engine, { run_id: id })).status).toBe('passed');
  return id;
}

describe('M9 at L1', () => {
  it('routes a gate 7 hold to Review first, and the report verify section matches verify_report.json and the events', async () => {
    const repo = gitRepo();
    const before = repoHash(repo);
    const out = tmpDir();
    const engine = createEngine({ out, level: 1, checks });
    try {
      const id = await planned(engine, repo);
      // L0 emit first: no verify report yet.
      expect((await emitPlan(engine, { run_id: id })).verify_report).toBeNull();

      await verifyStage(engine, { run_id: id, stage_id: BUMP_STAGE_ID });
      // A patch that drops a test case: checks stay green, gate 7 holds it for review.
      const held = await submitStagePatch(engine, { run_id: id, stage_id: BUMP_STAGE_ID, patch: [{ path: 'app/a.test.ts', content: "import { it, expect } from 'vitest';\nit('one', () => { expect(1).toBe(1); });\n" }], tokens: { in: 10, out: 5 } });
      expect(held.decision).toBe('rejected');
      expect(held.patch_path).toBe(path.join(id, 'patches', 'needs-review', `${BUMP_STAGE_ID}.patch`));

      const first = await emitPlan(engine, { run_id: id });
      expect(first.verify_report).toBe(`${id}/verify_report.json`);
      expect(first.routing.review_first).toBe(1);
      const md = readFileSync(path.join(out, first.plan_md), 'utf8');
      const review = md.slice(md.indexOf('## Review first'), md.indexOf('## Summary'));
      expect(review).toContain('gate 7 held the patch for review: fewer_test_cases');
      expect(review).toContain(`patches/needs-review/${BUMP_STAGE_ID}.patch`);
      expect(md).toContain('Verify: held for review by gate 7 after 1 attempt.');

      // A clean patch on the next attempt is kept, which clears the hold.
      const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      pkg.dependencies.next = '16.0.0';
      const kept = await submitStagePatch(engine, { run_id: id, stage_id: BUMP_STAGE_ID, patch: [{ path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` }] });
      expect(kept.decision).toBe('kept');
      const second = await emitPlan(engine, { run_id: id });
      expect(second.routing.review_first).toBe(0);

      const json = JSON.parse(readFileSync(path.join(out, second.verify_report!), 'utf8')) as VerifyReport;
      const report = readFileSync(path.join(out, second.run_report), 'utf8');
      const verify = report.slice(report.indexOf('## Verify (L1)'), report.indexOf('## Dropped'));
      expect(verify).toContain(`- Sandbox: \`${json.sandbox_path}\` at source HEAD \`${json.source_head}\``);
      for (const c of json.baseline_checks) expect(verify).toContain(`  - ${c.name}: ${c.status} (exit ${c.exit_code})`);
      for (const s of json.stages) {
        expect(verify).toContain(`- Stage \`${s.stage_id}\` (${s.title}): ${s.decision}, ${s.attempts.length} attempt${s.attempts.length === 1 ? '' : 's'}`);
        for (const a of s.attempts) expect(verify).toContain(`  - attempt ${a.attempt}: ${a.decision}; checks: ${a.checks.map((c) => `${c.name} ${c.status} exit ${c.exit_code}`)[0]}`);
      }
      expect(verify).toContain(`- Apply the kept patches yourself: \`${json.apply_command}\``);
      // Every command the spawn point ran is an exec.run event, and the report lists them all.
      const db = openSession(engine, repo).db;
      const execs = listEvents(db, id).filter((e) => e.kind === 'exec.run').map((e) => JSON.parse(e.payload_json) as { kind: string; argv: string[]; exit_code: number });
      expect(execs.length).toBeGreaterThan(0);
      expect(execs.some((x) => x.kind === 'check' && x.argv.join(' ') === 'node -e process.exit(0)')).toBe(true);
      expect(execs.some((x) => x.kind === 'git')).toBe(true);
      expect(verify).toContain(`- Commands run: ${execs.length}`);
      for (const x of execs) expect(verify).toContain(`[${x.kind}] \`${x.argv.join(' ')}\` → exit ${x.exit_code}`);
      // The reported tokens reached the cost table.
      expect(report).toMatch(/\| submit_stage_patch \| 2 \| \d+ \| 15 \|/);
    } finally {
      closeEngine(engine);
    }
    expect(repoHash(repo)).toBe(before);
  });

  it('a time budget cuts the stages not settled yet and refuses to start one', async () => {
    const repo = gitRepo();
    const before = repoHash(repo);
    let now = Date.parse('2026-10-22T10:00:00.000Z');
    const out = tmpDir();
    const engine = createEngine({ out, level: 1, checks, budget: { seconds: 30 }, now: () => new Date(now) });
    try {
      const id = await planned(engine, repo);
      now += 31_000;
      await expect(verifyStage(engine, { run_id: id, stage_id: BUMP_STAGE_ID })).rejects.toMatchObject({ code: 'budget_cut' });
      const db = openSession(engine, repo).db;
      const cuts = listEvents(db, id).filter((e) => e.kind === 'budget.cut').map((e) => JSON.parse(e.payload_json) as { what: string; id: string });
      expect(cuts).toEqual([expect.objectContaining({ what: 'stage', id: BUMP_STAGE_ID })]);
      const emitted = await emitPlan(engine, { run_id: id });
      expect(readFileSync(path.join(out, emitted.run_report), 'utf8')).toContain(`  - stage \`${BUMP_STAGE_ID}\`: 31 s over the budget of 30 s`);
    } finally {
      closeEngine(engine);
    }
    expect(repoHash(repo)).toBe(before);
  });
});
