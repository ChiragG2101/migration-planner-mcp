// The run budget (M9 task 5). Going over --budget-tokens or --budget-seconds
// records the lenses (and, at L1, the stages) not started yet as budget_cut,
// refuses new work, and the run report lists every cut. Nothing is skipped
// silently: the cut lens's usages stay uncovered for gate 2.
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  emitPlan,
  findUsages,
  getLensPacket,
  InputError,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  submitFindings,
  validatePlan,
  type Engine,
} from '../../src/core/index.js';
import { openSession } from '../../src/core/engine.js';
import { budgetUse, newCuts, overBudget, type BudgetEvent } from '../../src/pipeline/budget.js';
import { listEvents } from '../../src/store/events.js';
import { repoRoot, tmpDir } from '../helpers.js';

const e = (ts: string, tokens: [number, number] | null = null, kind = 'x', payload: unknown = null): BudgetEvent => ({
  ts,
  kind,
  payload_json: JSON.stringify(payload),
  tokens_in: tokens?.[0] ?? null,
  tokens_out: tokens?.[1] ?? null,
});

describe('budget accounting', () => {
  const events = [e('2026-10-22T10:00:00.000Z'), e('2026-10-22T10:00:05.000Z', [300, 200])];

  it('counts reported tokens and seconds since the run began', () => {
    expect(budgetUse(events, new Date('2026-10-22T10:00:30.000Z'))).toEqual({ seconds: 30, tokens: 500 });
  });

  it('is over budget only past a limit, and never without one', () => {
    const use = { seconds: 30, tokens: 500 };
    expect(overBudget(undefined, use)).toBeNull();
    expect(overBudget({ tokens: 500, seconds: 30 }, use)).toBeNull();
    expect(overBudget({ tokens: 499 }, use)).toContain('tokens 500 over the budget of 499');
    expect(overBudget({ seconds: 29 }, use)).toContain('over the budget of 29 s');
  });

  it('cuts each remaining item once', () => {
    const now = new Date('2026-10-22T10:00:30.000Z');
    const first = newCuts({ tokens: 10 }, events, now, [{ what: 'lens', id: 'api' }, { what: 'lens', id: 'verification' }]);
    expect(first.cuts.map((c) => c.id)).toEqual(['api', 'verification']);
    const again = newCuts({ tokens: 10 }, [...events, e('2026-10-22T10:00:06.000Z', null, 'budget.cut', first.cuts[0])], now, [{ what: 'lens', id: 'api' }, { what: 'lens', id: 'verification' }]);
    expect(again.reason).not.toBeNull();
    expect(again.cuts.map((c) => c.id)).toEqual(['verification']);
    expect(newCuts({ tokens: 10_000 }, events, now, [{ what: 'lens', id: 'api' }])).toEqual({ reason: null, cuts: [] });
  });

  it('createEngine refuses a budget or threshold that is not a usable number', () => {
    expect(() => createEngine({ budget: { tokens: 0 } })).toThrow(InputError);
    expect(() => createEngine({ budget: { seconds: Number.NaN } })).toThrow(InputError);
    expect(() => createEngine({ confidenceThreshold: 1.5 })).toThrow(InputError);
    expect(() => createEngine({ confidenceThreshold: -0.1 })).toThrow(InputError);
  });
});

async function trickyRun(engine: Engine): Promise<{ id: string; repo: string; repoId: string }> {
  const repo = path.join(tmpDir(), 'next-tricky');
  cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  return { id, repo, repoId: scan.run!.repo_id };
}

describe('over budget in a run', () => {
  it('a token budget cuts the lenses not fetched yet, once each, and the report lists them', async () => {
    const out = tmpDir();
    const engine = createEngine({ out, budget: { tokens: 100 } });
    try {
      const run = await trickyRun(engine);
      await getLensPacket(engine, { run_id: run.id, lens: 'api' });
      const sub = await submitFindings(engine, { run_id: run.id, lens: 'api', findings: [], out_of_scope: [], tokens: { in: 90, out: 30 } });
      expect(sub.accepted).toBe(true);

      await expect(getLensPacket(engine, { run_id: run.id, lens: 'dependency_build' })).rejects.toMatchObject({ code: 'budget_cut' });
      await expect(getLensPacket(engine, { run_id: run.id, lens: 'verification' })).rejects.toMatchObject({ code: 'budget_cut' });
      const db = openSession(engine, run.repo).db;
      const cuts = listEvents(db, run.id).filter((x) => x.kind === 'budget.cut').map((x) => JSON.parse(x.payload_json) as { what: string; id: string });
      expect(cuts.map((c) => `${c.what}:${c.id}`).sort()).toEqual(['lens:behavior_runtime', 'lens:dependency_build', 'lens:verification']);

      const merged = await mergeFindings(engine, { run_id: run.id });
      // The cut lenses' usages are not dropped: they stay uncovered, so gate 2 sees them.
      expect(merged.uncovered_usages.length).toBeGreaterThan(0);
      const validated = await validatePlan(engine, { run_id: run.id });
      expect(validated.results.some((r) => r.gate === 'g2_coverage' && !r.pass)).toBe(true);
      const emitted = await emitPlan(engine, { run_id: run.id });
      const report = readFileSync(path.join(out, emitted.run_report), 'utf8');
      expect(report).toContain('- Budget cuts: 3');
      for (const lens of ['behavior_runtime', 'dependency_build', 'verification']) expect(report).toContain(`  - lens \`${lens}\`: tokens 120 over the budget of 100`);
      expect(report).toContain('used 120 tokens');
      expect(report).toMatch(/\| submit_findings \| 1 \| \d+ \| 120 \|/);
    } finally {
      closeEngine(engine);
    }
  });

  it('a time budget cuts on the run clock', async () => {
    let now = Date.parse('2026-10-22T10:00:00.000Z');
    const engine = createEngine({ out: tmpDir(), budget: { seconds: 60 }, now: () => new Date(now) });
    try {
      const run = await trickyRun(engine);
      await getLensPacket(engine, { run_id: run.id, lens: 'api' });
      now += 61_000;
      await expect(getLensPacket(engine, { run_id: run.id, lens: 'verification' })).rejects.toMatchObject({ code: 'budget_cut' });
    } finally {
      closeEngine(engine);
    }
  });

  it('without a budget nothing is cut', async () => {
    const engine = createEngine({ out: tmpDir() });
    try {
      const run = await trickyRun(engine);
      await submitFindings(engine, { run_id: run.id, lens: 'api', findings: [], out_of_scope: [], tokens: { in: 1_000_000, out: 0 } }).catch(() => undefined);
      await expect(getLensPacket(engine, { run_id: run.id, lens: 'verification' })).resolves.toBeDefined();
    } finally {
      closeEngine(engine);
    }
  });
});
