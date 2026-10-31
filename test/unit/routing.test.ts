// Confidence routing (M9 task 1, INV-34, INV-71). A table over confidence
// 0.59 / 0.6 / 0.61, every severity and every source; the review-first rules
// (agent-judgment high or blocker at any confidence, a gate 7 hold, a scope
// exclusion or a lens mark whose rule breaks); and a custom threshold, which
// emit records with its source.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cpSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  emitPlan,
  findUsages,
  getLensPacket,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  submitFindings,
  validatePlan,
  type Engine,
} from '../../src/core/index.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  LENS_BREAKS_LINE,
  SCOPE_BREAKS_LINE,
  heldForReview,
  routePlan,
  type RoutingInput,
} from '../../src/pipeline/routing.js';
import type { ComposedRule } from '../../src/rules/compose.js';
import type { Finding } from '../../src/schema/finding.js';
import type { Plan } from '../../src/schema/plan.js';
import type { Usage } from '../../src/schema/usage.js';
import { listEvents } from '../../src/store/events.js';
import { openSession } from '../../src/core/engine.js';
import { repoRoot, tmpDir } from '../helpers.js';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'blocker'] as const;
const SOURCES = ['rule_pack', 'usage_scan', 'codemod', 'agent_judgment'] as const;

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    repo_id: 'r',
    lens: 'api',
    concern: 'api_change',
    severity: 'low',
    evidence: [{ repo_id: 'r', file: 'a.ts', line_start: 1, line_end: 1, snippet_hash: 'a'.repeat(64) }],
    doc_refs: [],
    reasoning: 'r',
    action: 'a',
    step_kind: 'manual',
    verify: 'v',
    confidence: 0.9,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

function usage(id: string, symbol: string): Usage {
  return {
    id,
    repo_id: 'r',
    file: `${id}.ts`,
    line_start: 3,
    line_end: 3,
    snippet_hash: 'b'.repeat(64),
    kind: 'request_api',
    symbol: `next/headers.${symbol}`,
    module: 'next/headers',
    match_kind: 'call',
    context: '',
    via: [],
    confidence: 'exact',
    labels: [],
  };
}

function rule(name: string, necessity: 'breaks' | 'deprecated'): ComposedRule {
  return { rule: { id: `next/${name}`, match: { kind: 'call', module: 'next/headers', name } }, necessity } as unknown as ComposedRule;
}

function plan(findings: Finding[], out_of_scope: Plan['out_of_scope'] = []): Plan {
  return {
    run_id: 'run',
    campaign_id: 'c',
    repo_id: 'r',
    pack: 'nextjs-upgrade@1',
    prompt_version: 'v1',
    stages: [{ id: 'stage-1', order: 0, title: 'One', finding_ids: findings.map((f) => f.id), depends_on: [] }],
    findings,
    out_of_scope,
    unresolved: [],
  };
}

const base = (p: Plan, over: Partial<RoutingInput> = {}): RoutingInput => ({ plan: p, threshold: DEFAULT_CONFIDENCE_THRESHOLD, usages: [], targetRules: [], runRules: [], ...over });

describe('confidence routing', () => {
  it('the default threshold is 0.6', () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.6);
  });

  describe.each([0.59, 0.6, 0.61])('confidence %s', (confidence) => {
    for (const severity of SEVERITIES) {
      for (const source of SOURCES) {
        it(`${severity} from ${source}`, () => {
          const f = finding('f', { severity, source, confidence });
          const r = routePlan(base(plan([f])));
          const review = (severity === 'high' || severity === 'blocker') && source === 'agent_judgment';
          const needsHuman = !review && confidence < 0.6;
          expect(r.review_first.map((x) => x.finding_id)).toEqual(review ? ['f'] : []);
          expect(r.needs_human).toEqual(needsHuman ? ['f'] : []);
          expect(r.main['stage-1']).toEqual(review || needsHuman ? [] : ['f']);
        });
      }
    }
  });

  it('an agent-judgment blocker at confidence 0.95 still goes to Review first', () => {
    const r = routePlan(base(plan([finding('b', { severity: 'blocker', source: 'agent_judgment', confidence: 0.95 })])));
    expect(r.review_first).toMatchObject([{ reason: 'agent_judgment', finding_id: 'b' }]);
    expect(r.main['stage-1']).toEqual([]);
  });

  it('an agent-judgment high finding below the threshold goes to Review first, not Needs human decision', () => {
    const r = routePlan(base(plan([finding('h', { severity: 'high', source: 'agent_judgment', confidence: 0.1 })])));
    expect(r.review_first.map((x) => x.finding_id)).toEqual(['h']);
    expect(r.needs_human).toEqual([]);
  });

  it('a custom threshold is respected', () => {
    const r = routePlan(base(plan([finding('x', { confidence: 0.61 }), finding('y', { confidence: 0.85 })]), { threshold: 0.8 }));
    expect(r.threshold).toBe(0.8);
    expect(r.needs_human).toEqual(['x']);
    expect(r.main['stage-1']).toEqual(['y']);
  });

  it('a gate 7 needs-review stage goes to Review first with the gate 7 reason, and a later kept attempt clears it', () => {
    const p = plan([finding('f')]);
    const held = { stage_id: 'stage-1', decision: 'rejected' as const, attempts: 1, held_for_review: ['fewer_test_cases in a.test.ts: 2 -> 1'] };
    const r = routePlan(base(p, { verify: [held] }));
    expect(r.review_first).toMatchObject([{ reason: 'gate7', stage_id: 'stage-1' }]);
    expect(r.review_first[0]!.detail).toContain('fewer_test_cases in a.test.ts');
    expect(routePlan(base(p, { verify: [{ ...held, decision: 'kept', attempts: 2 }] })).review_first).toEqual([]);
    expect(routePlan(base(p, { verify: [{ ...held, held_for_review: [] }] })).review_first).toEqual([]);
  });

  it('a gate 7 hold is clean checks with a failing gate 7, nothing else', () => {
    const fail = { pass: false, violations: [{ rule: 'fewer_test_cases' as const, file: 'a.test.ts', detail: '2 -> 1' }] };
    const pass = { pass: true, violations: [] };
    const ok = { name: 't', status: 'pass' as const, exit_code: 0, output_tail: '', duration_ms: 1 };
    expect(heldForReview([ok], fail)).toBe(true);
    expect(heldForReview([{ ...ok, status: 'flaky' }], fail)).toBe(true);
    expect(heldForReview([{ ...ok, status: 'baseline_failing' }], fail)).toBe(true);
    expect(heldForReview([{ ...ok, status: 'fail', exit_code: 1 }], fail)).toBe(false);
    expect(heldForReview([{ ...ok, status: 'timeout' }], fail)).toBe(false);
    expect(heldForReview([ok], pass)).toBe(false);
  });

  it('a usage the scope excluded goes to Review first when its rule breaks, not when it is only deprecated', () => {
    const usages = [usage('u1', 'cookies'), usage('u2', 'headers')];
    const rules = [rule('cookies', 'breaks'), rule('headers', 'deprecated')];
    const p = plan([], [
      { usage_id: 'u1', reason: 'scope: stop_at=15', written_by: 'scope' },
      { usage_id: 'u2', reason: 'scope: include_deprecated=no', written_by: 'scope' },
    ]);
    const r = routePlan(base(p, { usages, targetRules: rules, runRules: rules }));
    expect(r.review_first).toHaveLength(1);
    expect(r.review_first[0]).toMatchObject({ reason: 'scope_breaks', usage_id: 'u1' });
    expect(r.review_first[0]!.detail).toContain(SCOPE_BREAKS_LINE);
    expect(r.review_first[0]!.detail).toContain('u1.ts:3');
  });

  it('a scope exclusion is judged against the original target, not the stop_at range', () => {
    const usages = [usage('u1', 'cookies')];
    const p = plan([], [{ usage_id: 'u1', reason: 'scope: stop_at=15', written_by: 'scope' }]);
    // The breaking rule lies beyond stop_at, so only the target rules know it.
    const r = routePlan(base(p, { usages, targetRules: [rule('cookies', 'breaks')], runRules: [] }));
    expect(r.review_first.map((x) => x.reason)).toEqual(['scope_breaks']);
  });

  it('a usage a lens marked out of scope goes to Review first when its rule breaks; an engine entry never does', () => {
    const usages = [usage('u1', 'cookies'), usage('u2', 'cookies'), usage('u3', 'headers')];
    const rules = [rule('cookies', 'breaks'), rule('headers', 'deprecated')];
    const p = plan([], [
      { usage_id: 'u1', reason: 'already awaited', written_by: 'api' },
      { usage_id: 'u2', reason: 'no rule in range', written_by: 'engine' },
      { usage_id: 'u3', reason: 'already migrated', written_by: 'api' },
    ]);
    const r = routePlan(base(p, { usages, targetRules: rules, runRules: rules }));
    expect(r.review_first).toHaveLength(1);
    expect(r.review_first[0]).toMatchObject({ reason: 'lens_breaks', usage_id: 'u1' });
    expect(r.review_first[0]!.detail).toContain(LENS_BREAKS_LINE);
  });

  it('routing never changes the plan it is given', () => {
    const p = plan([finding('a', { confidence: 0.1 }), finding('b', { severity: 'high', source: 'agent_judgment' })]);
    const before = JSON.stringify(p);
    routePlan(base(p));
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('routing at emit (a full run on next-tricky)', () => {
  let engine: Engine;
  let out: string;
  beforeAll(() => {
    out = tmpDir();
    engine = createEngine({ out, confidenceThreshold: 0.8 });
  });
  afterAll(() => closeEngine(engine));

  it('populates Review first and Needs human decision by the rules, and records the threshold and its source', async () => {
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    const id = scan.run!.run_id;
    const repoId = scan.run!.repo_id;
    await findUsages(engine, { run_id: id });
    await proposeScope(engine, { run_id: id });
    await setScope(engine, { run_id: id, answers: {} });
    const packet = (await getLensPacket(engine, { run_id: id, lens: 'api' })).packet;
    const [a, b, c] = packet.usages;
    expect(c, 'the api packet has three usages').toBeDefined();
    const ev = (u: Usage) => [{ repo_id: repoId, file: u.file, line_start: u.line_start, line_end: u.line_end, snippet_hash: u.snippet_hash }];
    const mk = (fid: string, u: Usage, over: Partial<Finding>) => ({ ...finding(fid, { repo_id: repoId, evidence: ev(u), usage_ids: [u.id], verify: 'Load the page.', rollback: 'Revert the edit.' }), ...over });
    const sub = await submitFindings(engine, {
      run_id: id,
      lens: 'api',
      findings: [
        mk('judged', a!, { severity: 'blocker', source: 'agent_judgment', confidence: 0.95 }),
        mk('unsure', b!, { confidence: 0.7 }),
        mk('sure', c!, { confidence: 0.9 }),
      ],
      out_of_scope: [],
      tokens: { in: 100, out: 20 },
    });
    expect(sub.accepted, JSON.stringify(sub.errors)).toBe(true);
    await mergeFindings(engine, { run_id: id });
    await validatePlan(engine, { run_id: id });
    const emitted = await emitPlan(engine, { run_id: id });
    expect(emitted.routing).toEqual({ threshold: 0.8, threshold_source: 'flag', review_first: 1, needs_human: 1 });

    const md = readFileSync(path.join(out, emitted.plan_md), 'utf8');
    const reviewAt = md.indexOf('## Review first');
    const needsAt = md.indexOf('## Needs human decision');
    expect(reviewAt).toBeGreaterThan(0);
    expect(needsAt).toBeGreaterThan(reviewAt);
    expect(md.slice(reviewAt, needsAt)).toContain('#### judged');
    expect(md.slice(needsAt)).toContain('#### unsure');
    // The stage details list only the finding routing left in the main plan.
    const stagesAt = md.indexOf('## Stages');
    expect(md.slice(stagesAt)).toContain('#### sure');
    expect(md.slice(stagesAt)).not.toContain('#### judged');
    expect(md.slice(stagesAt)).not.toContain('#### unsure');
    expect(md).toContain('confidence threshold 0.8 (flag)');

    const db = openSession(engine, repo).db;
    const routing = listEvents(db, id).filter((e) => e.kind === 'routing.result').map((e) => JSON.parse(e.payload_json) as { threshold: number; threshold_source: string });
    expect(routing.at(-1)).toMatchObject({ threshold: 0.8, threshold_source: 'flag' });
    // plan.json is the gated plan, unchanged by routing: all three findings are still in their stage.
    const json = JSON.parse(readFileSync(path.join(out, emitted.plan_json), 'utf8')) as Plan;
    expect(json.findings.map((f) => f.id).sort()).toEqual(expect.arrayContaining(['judged', 'sure', 'unsure']));
  });
});
