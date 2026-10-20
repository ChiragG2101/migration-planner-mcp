// merge_findings -> validate_plan -> emit_plan (M6 tasks 1, 3, 4), end to end
// through the engine. Covers: the engine-built `none` plan, the round cap of 3
// with unresolved[] (a capped plan is never passed), emit's refusal until the
// latest round is validated, that emit writes only under <out> and never the
// repo, and the scope freeze merge triggers.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  emitPlan,
  findUsages,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  validatePlan,
  type Engine,
} from '../../src/core/index.js';
import { BUMP_STAGE_ID } from '../../src/pipeline/aggregate.js';
import { MAX_ROUNDS } from '../../src/core/validatePlan.js';
import { Plan } from '../../src/schema/plan.js';
import { copyFixture, repoRoot, tmpDir } from '../helpers.js';
import { cpSync } from 'node:fs';

let engine: Engine;
let out: string;

beforeAll(() => {
  out = tmpDir();
  engine = createEngine({ out });
});
afterAll(() => closeEngine(engine));

async function ready(repo: string, size: 'none' | 'full'): Promise<string> {
  const target = size === 'none' ? '16.0.0' : '16.0.0';
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: target } });
  expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  return id;
}

function trickyRepo(): string {
  const root = path.join(tmpDir(), 'next-tricky');
  cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), root, { recursive: true });
  return root;
}

describe('merge_findings, validate_plan and emit_plan', () => {
  it('builds a none plan with one bump stage, validates it and emits outside the repo', async () => {
    const repo = copyFixture('next-clean');
    const id = await ready(repo, 'none');

    const merged = await mergeFindings(engine, { run_id: id });
    expect(merged.size).toBe('none');
    expect(merged.round).toBe(1);
    // Exactly one stage, the bump stage, holding the templated bump finding.
    expect(merged.plan.stages.map((s) => s.id)).toEqual([BUMP_STAGE_ID]);
    expect(merged.plan.findings.map((f) => f.id)).toContain('engine-bump');
    // The none plan also names the behaviour changes from propose_scope (D12):
    // next 14 -> 16 carries changed-default rules, surfaced as info findings.
    const behavior = merged.plan.findings.filter((f) => f.concern === 'behavior_change');
    expect(behavior.length).toBeGreaterThan(0);
    expect(behavior.every((f) => f.severity === 'info' && f.evidence.length === 0)).toBe(true);
    // The plan parses against the schema (gate 6's own check, here as a guard).
    expect(() => Plan.parse(merged.plan)).not.toThrow();

    const validated = await validatePlan(engine, { run_id: id });
    expect(validated.status, JSON.stringify(validated.results.filter((r) => !r.pass), null, 2)).toBe('passed');
    expect(validated.passed).toBe(true);
    expect(validated.unresolved).toEqual([]);

    const emitted = await emitPlan(engine, { run_id: id });
    expect(emitted.plan_json).toBe(`${id}/plan.json`);
    expect(emitted.plan_md).toBe(`${id}/MIGRATION_PLAN.md`);
    // Written under <out>, parse-equal to the stored plan, and NOT inside the repo.
    const jsonPath = path.join(out, emitted.plan_json);
    expect(existsSync(jsonPath)).toBe(true);
    expect(Plan.parse(JSON.parse(readFileSync(jsonPath, 'utf8')))).toEqual(merged.plan);
    expect(existsSync(path.join(out, emitted.plan_md))).toBe(true);
    // Nothing was written into the repo tree.
    expect(readdirSync(repo)).not.toContain('plan.json');
    expect(readdirSync(repo)).not.toContain('MIGRATION_PLAN.md');
    expect(jsonPath.startsWith(path.resolve(out))).toBe(true);
    expect(jsonPath.startsWith(path.resolve(repo))).toBe(false);
  });

  it('refuses emit_plan until validate_plan has run on the latest round', async () => {
    const id = await ready(copyFixture('next-clean'), 'none');
    await mergeFindings(engine, { run_id: id });
    await expect(emitPlan(engine, { run_id: id })).rejects.toMatchObject({ code: 'not_validated' });
    // After validate, emit is allowed.
    await validatePlan(engine, { run_id: id });
    await expect(emitPlan(engine, { run_id: id })).resolves.toMatchObject({ run_id: id });
  });

  it('caps at 3 rounds, moves failures to unresolved[] and never marks the plan passed', async () => {
    const id = await ready(trickyRepo(), 'full');
    const merged = await mergeFindings(engine, { run_id: id });
    // A full run with no submitted lens findings leaves reviewed-rule usages
    // uncovered, so gate 2 fails and the plan can never pass.
    expect(merged.uncovered_usages.length).toBeGreaterThan(0);

    let last;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      last = await validatePlan(engine, { run_id: id });
      expect(last.round).toBe(round);
      expect(last.passed).toBe(false);
      if (round < MAX_ROUNDS) {
        expect(last.status).toBe('failed');
        expect(last.capped).toBe(false);
        expect(last.unresolved).toEqual([]);
      }
    }
    // Round 3: capped, unresolved populated, status never 'passed'.
    expect(last!.round).toBe(MAX_ROUNDS);
    expect(last!.status).toBe('capped');
    expect(last!.capped).toBe(true);
    expect(last!.unresolved.length).toBeGreaterThan(0);
    expect(last!.unresolved.every((u) => u.reason.trim() !== '')).toBe(true);

    // A fourth round stays capped and never flips to passed.
    const fourth = await validatePlan(engine, { run_id: id });
    expect(fourth.round).toBe(MAX_ROUNDS + 1);
    expect(fourth.status).toBe('capped');
    expect(fourth.passed).toBe(false);

    // The emitted plan carries the unresolved section and is still outside the repo.
    const emitted = await emitPlan(engine, { run_id: id });
    expect(emitted.unresolved).toBeGreaterThan(0);
    const md = readFileSync(path.join(out, emitted.plan_md), 'utf8');
    expect(md.toLowerCase()).toContain('unresolved');
  });

  it('freezes scope the moment merge_findings runs', async () => {
    const id = await ready(copyFixture('next-clean'), 'none');
    await mergeFindings(engine, { run_id: id });
    await expect(setScope(engine, { run_id: id, answers: {} })).rejects.toMatchObject({ code: 'scope_frozen' });
  });
});
