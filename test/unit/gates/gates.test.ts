// The six gates, one bad-plan fixture each (the milestone's "done when"). Each
// bad fixture fails ONLY its target gate, and the others pass, so the gates are
// shown independent. The false-pass checks mutate the good plan and assert the
// gate flips (a gate that still passes after a mutation is a bug).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGates, type GateContext } from '../../../src/pipeline/gates/index.js';
import { Plan, type GateId } from '../../../src/schema/plan.js';
import type { RunDocRow } from '../../../src/store/docs.js';
import type { ImportRow } from '../../../src/store/usages.js';
import type { Usage } from '../../../src/schema/usage.js';
import { copyFixture, fixturesDir } from '../../helpers.js';

const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixturesDir, 'plans', `${name}.json`), 'utf8'));

function usage(id: string, file: string, line: number, kind: string): Usage {
  return {
    id,
    repo_id: 'repo',
    file,
    line_start: line,
    line_end: line,
    snippet_hash: 'x',
    kind,
    symbol: kind,
    module: null,
    match_kind: null,
    context: '',
    via: [],
    confidence: 'exact',
    labels: [],
  };
}

function doc(doc_id: string, url: string): RunDocRow {
  return {
    run_id: 'run-good',
    doc_id,
    mode: 'register',
    status: 'fresh',
    fetched_by: 'agent',
    official: true,
    library: 'next',
    version: '15',
    topic: 't',
    url,
    content: 'c',
    fetched_at: '2026-01-01T00:00:00.000Z',
    source: 'agent',
  };
}

/** The context the good plan passes against: the real plan-repo fixture, its usages, graph and docs. */
function context(): GateContext {
  const repoRoot = copyFixture('plan-repo');
  const imports: ImportRow[] = [{ from_file: 'app/page.tsx', to_module: './leaf.js', to_file: 'app/leaf.ts', kind: 'import', line: 1, lang: 'ts', confidence: 'exact' }];
  return {
    repoRoot,
    repoId: 'repo',
    usages: [usage('u-leaf', 'app/leaf.ts', 1, 'renamed_api'), usage('u-page', 'app/page.tsx', 1, 'request_api')],
    imports,
    docs: [doc('doc-leaf', 'https://nextjs.org/docs/leaf'), doc('doc-page', 'https://nextjs.org/docs/page')],
    landsOn: new Map([['f-leaf', 'source'], ['engine-bump', 'source'], ['f-page', 'target']]),
    bumpStageId: 'stage-bump',
  };
}

// Bad fixtures are passed to the gates as stored (not re-parsed by the test),
// since gate 6 is exactly the schema check; gates 1 to 5 tolerate the odd
// shapes these fixtures carry (they never dereference the dropped field).
const failures = (plan: unknown, ctx: GateContext): GateId[] =>
  [...new Set(runGates(plan as Plan, ctx).filter((r) => !r.pass).map((r) => r.gate))];

describe('gates', () => {
  it('the good plan passes every gate', () => {
    const results = runGates(Plan.parse(load('good')), context());
    const bad = results.filter((r) => !r.pass);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
  });

  const cases: { fixture: string; gate: GateId }[] = [
    { fixture: 'bad-g1', gate: 'g1_evidence' },
    { fixture: 'bad-g2', gate: 'g2_coverage' },
    { fixture: 'bad-g3', gate: 'g3_doc_refs' },
    { fixture: 'bad-g4', gate: 'g4_rollback_verify' },
    { fixture: 'bad-g5', gate: 'g5_stage_order' },
    { fixture: 'bad-g6', gate: 'g6_schema_ids' },
  ];

  for (const { fixture, gate } of cases) {
    it(`${fixture} fails only ${gate}`, () => {
      const failed = failures(load(fixture), context());
      expect(failed, `expected only ${gate}, got ${failed.join(', ')}`).toEqual([gate]);
    });
  }

  // The six "remove the guard, a test fails" checks: mutate the good plan so
  // exactly one gate's condition breaks, and assert that gate flips to failing.
  // A gate that still passes after its own precondition is violated is a bug.
  it('g1 flips when an evidence snippet_hash no longer matches the file', () => {
    const plan = Plan.parse(load('good'));
    plan.findings[0]!.evidence[0]!.snippet_hash = 'b'.repeat(64);
    expect(failures(plan, context())).toContain('g1_evidence');
  });

  it('g2 flips on an out_of_scope entry with an empty reason', () => {
    // Passed raw: an empty reason is also a schema violation, so this isolates
    // gate 2's own empty-reason branch without re-parsing.
    const raw = load('good') as { out_of_scope: unknown[]; findings: { usage_ids: string[] }[] };
    raw.findings[2]!.usage_ids = []; // uncover u-page so only the scope entry can cover it
    raw.out_of_scope = [{ usage_id: 'u-page', reason: '   ', written_by: 'engine' }];
    const failed = [...new Set(runGates(raw as unknown as Plan, context()).filter((r) => !r.pass).map((r) => r.gate))];
    expect(failed).toContain('g2_coverage');
  });

  it('g3 flips when a doc_ref cites a doc_id not registered in the run', () => {
    const plan = Plan.parse(load('good'));
    plan.findings[0]!.doc_refs[0]!.doc_id = 'doc-not-in-run';
    expect(failures(plan, context())).toContain('g3_doc_refs');
  });

  it('g4 flips when a high finding loses its rollback', () => {
    const plan = Plan.parse(load('good'));
    delete plan.findings[2]!.rollback; // f-page is high
    expect(failures(plan, context())).toContain('g4_rollback_verify');
  });

  it('g5 flips on a depends_on cycle', () => {
    const plan = Plan.parse(load('good'));
    plan.stages[0]!.depends_on = ['stage-apply']; // prep <- apply <- bump <- prep
    expect(failures(plan, context())).toContain('g5_stage_order');
  });

  it('g6 flips on a duplicate finding id', () => {
    const plan = Plan.parse(load('good'));
    plan.findings[1]!.id = plan.findings[0]!.id;
    expect(failures(plan, context())).toContain('g6_schema_ids');
  });

  it('g6 isolates the duplicate-id branch: two findings share an id, both staged once', () => {
    // A second finding with the same id as f-leaf, added to the same stage so
    // the id is `placed` exactly once (no orphan, no placed-twice): the only
    // thing wrong is the duplicate id itself.
    const plan = Plan.parse(load('good'));
    const dup = structuredClone(plan.findings.find((f) => f.id === 'f-leaf')!);
    dup.severity = 'low';
    plan.findings.push(dup); // two findings, both id 'f-leaf'
    const results = runGates(plan, context());
    const dupMsgs = results.filter((r) => r.gate === 'g6_schema_ids' && !r.pass && /used more than once/.test(r.reason));
    expect(dupMsgs.map((r) => r.subject)).toEqual(['f-leaf']);
    // No orphan or placed-in-2-stages message, so the dup-id branch is isolated.
    expect(results.some((r) => r.gate === 'g6_schema_ids' && /is in no stage|placed in \d+ stages/.test(r.reason))).toBe(false);
    expect(failures(plan, context())).toEqual(['g6_schema_ids']);
  });

  // g1: the unreadable-file branch (a file not in the repo) is a named failure,
  // not a silent pass. bad-g1 carries an evidence entry at a non-existent file.
  it('g1 reports an evidence file that cannot be read', () => {
    const results = runGates(load('bad-g1') as Plan, context());
    const g1 = results.filter((r) => r.gate === 'g1_evidence' && !r.pass);
    expect(g1.some((r) => r.subject === 'f-missing' && /could not be read/.test(r.reason))).toBe(true);
  });

  // g4: the placeholder blocklist rejects a bare "revert" but accepts a real
  // sentence that starts with "revert" (PRD §7, the plan's "done when"). Both
  // branches are exercised so removing `if (t === 'revert') return true;`
  // turns the first case green and fails this test.
  it('g4 fails a high finding whose rollback is a bare "revert"', () => {
    const plan = Plan.parse(load('good'));
    plan.findings[2]!.rollback = 'revert'; // f-page is high
    const results = runGates(plan, context());
    const g4 = results.filter((r) => r.gate === 'g4_rollback_verify' && !r.pass);
    expect(g4.map((r) => r.subject)).toContain('f-page');
    expect(failures(plan, context())).toEqual(['g4_rollback_verify']);
  });

  it('g4 accepts a high finding whose rollback is a real sentence starting with "revert"', () => {
    const plan = Plan.parse(load('good'));
    plan.findings[2]!.rollback = 'revert the next.config change and reinstall 14';
    expect(failures(plan, context())).toEqual([]);
  });

  // g5: the transitive import-ordering branch (INV-19). page.tsx imports
  // leaf.ts, so a plan that changes the importer (page.tsx) in an earlier stage
  // than its dependency (leaf.ts) must fail: the dependency changes later.
  // Both findings land on source and there is no bump stage, so neither the
  // target-before-bump nor the cycle branch can be what trips the gate.
  it('g5 fails when an importer is staged before the dependency it imports', () => {
    const ctx: GateContext = { ...context(), landsOn: new Map([['f-leaf', 'source'], ['f-page', 'source']]), bumpStageId: null };
    const plan = Plan.parse(load('good'));
    plan.stages = [
      { id: 'stage-importer', order: 0, title: 'Change the importer first (wrong)', finding_ids: ['f-page'], depends_on: [] },
      { id: 'stage-dep', order: 1, title: 'Change its dependency later (wrong)', finding_ids: ['f-leaf'], depends_on: ['stage-importer'] },
    ];
    // Drop the bump finding so the two-stage plan stays schema-valid and only
    // the import-graph ordering is in play.
    plan.findings = plan.findings.filter((f) => f.id === 'f-leaf' || f.id === 'f-page');
    const results = runGates(plan, ctx);
    const g5 = results.filter((r) => r.gate === 'g5_stage_order' && !r.pass);
    expect(g5.length, JSON.stringify(results.filter((r) => !r.pass), null, 2)).toBeGreaterThan(0);
    expect(g5.some((r) => r.subject === 'f-page' && /imports app\/leaf\.ts/.test(r.reason) && /changed later/.test(r.reason))).toBe(true);
    expect([...new Set(results.filter((r) => !r.pass).map((r) => r.gate))]).toEqual(['g5_stage_order']);
  });

  it('g5 passes when the dependency is staged before its importer', () => {
    const ctx: GateContext = { ...context(), landsOn: new Map([['f-leaf', 'source'], ['f-page', 'source']]), bumpStageId: null };
    const plan = Plan.parse(load('good'));
    plan.stages = [
      { id: 'stage-dep', order: 0, title: 'Change the dependency first (right)', finding_ids: ['f-leaf'], depends_on: [] },
      { id: 'stage-importer', order: 1, title: 'Then the importer', finding_ids: ['f-page'], depends_on: ['stage-dep'] },
    ];
    plan.findings = plan.findings.filter((f) => f.id === 'f-leaf' || f.id === 'f-page');
    expect(failures(plan, ctx)).toEqual([]);
  });
});
