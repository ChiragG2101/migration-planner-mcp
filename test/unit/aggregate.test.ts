// The deterministic aggregator's pure core (M6 task 1): the action normaliser,
// span/action dedupe with severity-conflict resolution, out-of-scope precedence
// (scope > engine > lens, finding outranks a lens mark), the scope-vs-finding
// drop, and the engine-built `none` plan. No engine, no files, no model.
import { describe, expect, it } from 'vitest';
import { aggregate, aggregateNone, dedupe, normaliseAction, type AggregateInput } from '../../src/pipeline/aggregate.js';
import type { Finding } from '../../src/schema/finding.js';
import type { MergeConflict } from '../../src/schema/plan.js';
import type { Usage } from '../../src/schema/usage.js';

const HASH = 'a'.repeat(64);

function finding(over: Partial<Finding> & Pick<Finding, 'id'>): Finding {
  return {
    repo_id: 'repo',
    lens: 'api',
    concern: 'api_change',
    severity: 'medium',
    evidence: [{ repo_id: 'repo', file: 'app/a.ts', line_start: 1, line_end: 1, snippet_hash: HASH }],
    doc_refs: [],
    reasoning: 'r',
    action: 'Rename the API.',
    step_kind: 'manual',
    verify: 'Run the tests.',
    confidence: 0.5,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

function usage(id: string, over: Partial<Usage> = {}): Usage {
  return {
    id,
    repo_id: 'repo',
    file: 'app/a.ts',
    line_start: 1,
    line_end: 1,
    snippet_hash: HASH,
    kind: 'renamed_api',
    symbol: 's',
    module: null,
    match_kind: null,
    context: '',
    via: [],
    confidence: 'exact',
    labels: [],
    ...over,
  };
}

function input(over: Partial<AggregateInput>): AggregateInput {
  return {
    runId: 'run',
    campaignId: 'camp',
    repoId: 'repo',
    packRef: 'pack@1',
    promptVersion: 'v1',
    size: 'full',
    findings: [],
    marks: [],
    scopeExcluded: [],
    usages: [],
    imports: [],
    composed: { libraries: [], notes: [], targets: {} },
    staging: 'leaf_first',
    kind: 'upgrade',
    bumpFinding: finding({ id: 'engine-bump', severity: 'high', concern: 'dependency', evidence: [{ repo_id: 'repo', file: 'package.json', line_start: 1, line_end: 1, snippet_hash: HASH }], rollback: 'revert the bump', action: 'Bump the dep.' }),
    hiddenBehavior: [],
    ...over,
  };
}

describe('normaliseAction', () => {
  it('lowercases, collapses whitespace and strips punctuation so trivially different actions merge', () => {
    expect(normaliseAction('Rename  the API!!')).toBe(normaliseAction('rename the api'));
    expect(normaliseAction('Await the\trequest.')).toBe('await the request');
  });
  it('keeps genuinely different actions distinct', () => {
    expect(normaliseAction('Rename the API')).not.toBe(normaliseAction('Delete the API'));
  });
});

describe('dedupe', () => {
  it('merges same span and action, takes the higher severity and records a severity conflict', () => {
    const conflicts: MergeConflict[] = [];
    const merged = dedupe(
      [finding({ id: 'a', severity: 'low', usage_ids: ['u1'] }), finding({ id: 'b', severity: 'high', usage_ids: ['u2'] })],
      conflicts,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.finding.severity).toBe('high');
    expect([...merged[0]!.finding.usage_ids].sort()).toEqual(['u1', 'u2']);
    expect(conflicts.some((c) => c.kind === 'severity')).toBe(true);
  });

  it('keeps two different actions on one span and flags them as overlapping', () => {
    const conflicts: MergeConflict[] = [];
    const merged = dedupe([finding({ id: 'a', action: 'Rename the API.' }), finding({ id: 'b', action: 'Delete the API.' })], conflicts);
    expect(merged).toHaveLength(2);
    expect(merged.every((m) => m.overlapping)).toBe(true);
    expect(conflicts.some((c) => c.kind === 'overlapping')).toBe(true);
  });
});

describe('out-of-scope precedence (D16)', () => {
  it('scope outranks the engine fallback and a lens mark for the same usage', () => {
    const res = aggregate(
      input({
        usages: [usage('u1')],
        scopeExcluded: [{ usage_id: 'u1', reason: 'excluded by stop_at 15' }],
        marks: [{ lens: 'api', usage_id: 'u1', reason: 'lens says skip' }],
      }),
    );
    const entry = res.plan.out_of_scope.find((o) => o.usage_id === 'u1');
    expect(entry).toBeDefined();
    expect(entry!.written_by).toBe('scope');
    expect(entry!.reason).toBe('excluded by stop_at 15');
  });

  it('gives an unmatched, uncovered usage the engine reason "no rule in range"', () => {
    const res = aggregate(input({ usages: [usage('u1', { match_kind: null })] }));
    const entry = res.plan.out_of_scope.find((o) => o.usage_id === 'u1');
    expect(entry).toMatchObject({ written_by: 'engine', reason: 'no rule in range' });
    expect(res.uncovered).toEqual([]);
  });

  it('a finding outranks a lens mark on the same usage; the mark is dropped with a conflict', () => {
    const res = aggregate(
      input({
        usages: [usage('u1')],
        findings: [finding({ id: 'f', usage_ids: ['u1'] })],
        marks: [{ lens: 'api', usage_id: 'u1', reason: 'lens says skip' }],
      }),
    );
    expect(res.plan.out_of_scope.find((o) => o.usage_id === 'u1')).toBeUndefined();
    expect(res.conflicts.some((c) => c.kind === 'lens_vs_finding')).toBe(true);
  });

  it('drops a scope-excluded usage from a finding, and drops the finding when it then covers nothing', () => {
    const res = aggregate(
      input({
        usages: [usage('u1')],
        findings: [finding({ id: 'f', usage_ids: ['u1'] })],
        scopeExcluded: [{ usage_id: 'u1', reason: 'out of range' }],
      }),
    );
    expect(res.droppedFindings).toContain('f');
    expect(res.plan.findings.map((f) => f.id)).not.toContain('f');
    expect(res.conflicts.some((c) => c.kind === 'scope_vs_finding')).toBe(true);
    // The usage is still accounted for, now via the scope entry.
    expect(res.plan.out_of_scope.find((o) => o.usage_id === 'u1')?.written_by).toBe('scope');
  });
});

describe('staging', () => {
  it('orders prep (lands_on source) before the bump stage and target work after it', () => {
    // No rules, so every finding lands on target; only the bump is source/prep.
    const res = aggregate(
      input({
        usages: [usage('u1')],
        findings: [finding({ id: 'f-target', usage_ids: ['u1'] })],
      }),
    );
    const ids = res.plan.stages.map((s) => s.id);
    expect(ids).toContain('stage-bump');
    const bumpIdx = ids.indexOf('stage-bump');
    const applyIdx = ids.indexOf('stage-apply');
    expect(applyIdx).toBeGreaterThan(bumpIdx);
    // Orders are strictly increasing and depends_on chains back one stage.
    expect(res.plan.stages.map((s) => s.order)).toEqual([...res.plan.stages.keys()]);
  });
});

describe('staging order within a stage', () => {
  it('config_first lifts a config finding to the front of the target work', () => {
    const res = aggregate(
      input({
        staging: 'config_first',
        usages: [usage('u-cfg', { file: 'next.config.mjs' }), usage('u-leaf', { file: 'app/leaf.ts' })],
        findings: [
          finding({ id: 'f-leaf', usage_ids: ['u-leaf'], evidence: [{ repo_id: 'repo', file: 'app/leaf.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
          finding({ id: 'f-cfg', usage_ids: ['u-cfg'], evidence: [{ repo_id: 'repo', file: 'next.config.mjs', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
        ],
      }),
    );
    const apply = res.plan.stages.find((s) => s.id === 'stage-apply')!;
    expect(apply.finding_ids.indexOf('f-cfg')).toBeLessThan(apply.finding_ids.indexOf('f-leaf'));
  });

  it('orders codemod steps before manual steps within a stage', () => {
    const res = aggregate(
      input({
        usages: [usage('u1', { file: 'app/one.ts' }), usage('u2', { file: 'app/two.ts' })],
        findings: [
          finding({ id: 'f-manual', step_kind: 'manual', usage_ids: ['u1'], evidence: [{ repo_id: 'repo', file: 'app/two.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
          finding({ id: 'f-codemod', step_kind: 'codemod', codemod: 'next-codemod@15/app-dir-runtime-config-experimental-edge', rule_id: 'next/15/x', usage_ids: ['u2'], evidence: [{ repo_id: 'repo', file: 'app/one.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
        ],
      }),
    );
    const apply = res.plan.stages.find((s) => s.id === 'stage-apply')!;
    expect(apply.finding_ids.indexOf('f-codemod')).toBeLessThan(apply.finding_ids.indexOf('f-manual'));
  });

  it('puts a lands_on: source finding in a prep stage before the bump, and a target finding after', () => {
    // A composed rule whose id the finding names, with lands_on source. landsOnOf
    // reads the rule's lands_on directly when the finding carries its rule_id.
    const sourceRule = { rule: { id: 'next/14/prep', match: {} }, lands_on: 'source' } as unknown;
    const res = aggregate(
      input({
        composed: { libraries: [{ rules: [sourceRule] }] as never, notes: [], targets: {} },
        usages: [usage('u-prep', { file: 'app/prep.ts' }), usage('u-after', { file: 'app/after.ts' })],
        findings: [
          finding({ id: 'f-prep', rule_id: 'next/14/prep', usage_ids: ['u-prep'], evidence: [{ repo_id: 'repo', file: 'app/prep.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
          finding({ id: 'f-after', usage_ids: ['u-after'], evidence: [{ repo_id: 'repo', file: 'app/after.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }),
        ],
      }),
    );
    const order = (id: string): number => res.plan.stages.find((s) => s.finding_ids.includes(id))!.order;
    const bumpOrder = res.plan.stages.find((s) => s.id === 'stage-bump')!.order;
    expect(order('f-prep')).toBeLessThan(bumpOrder);
    expect(order('f-after')).toBeGreaterThan(bumpOrder);
    expect(res.landsOn.get('f-prep')).toBe('source');
    expect(res.landsOn.get('f-after')).toBe('target');
  });
});

describe('aggregateNone (D12)', () => {
  it('builds exactly one bump stage, the bump finding, and the engine reason on every non-excluded usage', () => {
    const res = aggregateNone(input({ size: 'none', usages: [usage('u1'), usage('u2')], scopeExcluded: [{ usage_id: 'u2', reason: 'out of range' }] }));
    expect(res.plan.stages.map((s) => s.id)).toEqual(['stage-bump']);
    expect(res.plan.findings.map((f) => f.id)).toEqual(['engine-bump']);
    const byId = new Map(res.plan.out_of_scope.map((o) => [o.usage_id, o]));
    expect(byId.get('u1')).toMatchObject({ written_by: 'engine', reason: 'no rule in range' });
    expect(byId.get('u2')).toMatchObject({ written_by: 'scope', reason: 'out of range' });
    expect(res.uncovered).toEqual([]);
  });

  it('lists the behaviour changes from propose_scope as info findings in the bump stage', () => {
    const res = aggregateNone(
      input({
        size: 'none',
        usages: [usage('u1')],
        hiddenBehavior: [{ id: 'next/15/caching-default', title: 'fetch is no longer cached by default' }],
      }),
    );
    const behavior = res.plan.findings.find((f) => f.concern === 'behavior_change');
    expect(behavior).toBeDefined();
    expect(behavior!.severity).toBe('info');
    expect(behavior!.evidence).toEqual([]);
    expect(behavior!.reasoning).toContain('fetch is no longer cached by default');
    // It is placed in the one bump stage, so gate 6 (every finding staged) passes.
    expect(res.plan.stages[0]!.finding_ids).toContain(behavior!.id);
  });
});
