// Metrics unit tests with hand-computed fixtures (M7 Tests: metrics, seeded
// precision, pooled recall, worst/best invariance).
import { describe, expect, it } from 'vitest';
import {
  bandFigure,
  bestRun,
  pooledRecall,
  ratio,
  score,
  seededPrecision,
  worstRun,
  type CaseRunRecall,
  type ScoredFinding,
} from '../../../eval/metrics.js';
import type { UsageSpan } from '../../../eval/schema.js';

const span = (file: string, s: number, h: string): UsageSpan => ({ file, line_start: s, line_end: s, snippet_hash: h.padEnd(64, '0') });

describe('score', () => {
  const t1 = span('a.ts', 1, 'a');
  const t2 = span('b.ts', 2, 'b');
  const t3 = span('c.ts', 3, 'c');

  const finding = (over: UsageSpan[], sev: ScoredFinding['severity'], files: string[], valid = true): ScoredFinding => ({
    spans: over,
    severity: sev,
    evidence_valid: valid,
    proposes_change: true,
    files,
    confidence: 0.9,
  });

  it('computes recall over true changed usages matched by span', () => {
    const s = score({
      truth: [t1, t2, t3],
      truth_files: ['a.ts', 'b.ts', 'c.ts'],
      edit_size: { 'a.ts': 10, 'b.ts': 1, 'c.ts': 5 },
      findings: [finding([t1], 'high', ['a.ts']), finding([t3], 'low', ['c.ts'])],
      out_of_scope: [],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.recall).toEqual({ found: 2, total: 3 });
  });

  it('file precision counts listed files the PR also touched', () => {
    const s = score({
      truth: [t1],
      truth_files: ['a.ts'],
      edit_size: { 'a.ts': 10 },
      findings: [finding([t1], 'low', ['a.ts']), finding([], 'low', ['z.ts'])],
      out_of_scope: [],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.file_precision).toEqual({ found: 1, total: 2 });
  });

  it('severity calibration counts high/blocker findings whose files needed non-trivial edits', () => {
    const s = score({
      truth: [t1, t2],
      truth_files: ['a.ts', 'b.ts'],
      edit_size: { 'a.ts': 10, 'b.ts': 1 }, // b.ts is a trivial 1-line edit (< 3)
      findings: [finding([t1], 'high', ['a.ts']), finding([t2], 'blocker', ['b.ts'])],
      out_of_scope: [],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.severity_calibration).toEqual({ found: 1, total: 2 });
  });

  it('false-alarm rate counts high/blocker findings on files the PR did not touch', () => {
    const s = score({
      truth: [t1],
      truth_files: ['a.ts'],
      edit_size: { 'a.ts': 10 },
      findings: [finding([], 'high', ['x.ts']), finding([t1], 'high', ['a.ts'])],
      out_of_scope: [],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.false_alarm_high).toEqual({ found: 1, total: 2 });
  });

  it('evidence validity is the share of change findings whose evidence resolves', () => {
    const s = score({
      truth: [t1],
      truth_files: ['a.ts'],
      edit_size: {},
      findings: [finding([t1], 'low', ['a.ts'], true), finding([], 'low', ['y.ts'], false)],
      out_of_scope: [],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.evidence_validity).toEqual({ found: 1, total: 2 });
  });

  it('splits out_of_scope by written_by', () => {
    const s = score({
      truth: [],
      truth_files: [],
      edit_size: {},
      findings: [],
      out_of_scope: [
        { usage: t1, written_by: 'scope' },
        { usage: t2, written_by: 'engine' },
        { usage: t3, written_by: 'api' },
      ],
      unresolved: 0,
      dropped_findings: 0,
    });
    expect(s.out_of_scope_by_written_by).toEqual({ scope: 1, engine: 1, api: 1 });
  });
});

describe('seeded precision (INV-31)', () => {
  it('counts a change on a no_change or no_finding entry as a false alarm; an out-of-scope mark on no_change is fine', () => {
    const r = seededPrecision([
      { id: 'c1', expect: 'change', proposed_change: true, marked_out_of_scope: false },
      { id: 'nc1', expect: 'no_change', proposed_change: false, marked_out_of_scope: true }, // correct
      { id: 'nc2', expect: 'no_change', proposed_change: true, marked_out_of_scope: false }, // false alarm
      { id: 'nf1', expect: 'no_finding', proposed_change: true, marked_out_of_scope: false }, // false alarm
      { id: 'nf2', expect: 'no_finding', proposed_change: false, marked_out_of_scope: false }, // correct
    ]);
    expect(r).toEqual({ false_alarms: 2, decoys: 2 });
  });
});

describe('pooled recall and the band (D17)', () => {
  const runs = (id: string, pairs: [number, number][]): CaseRunRecall[] => pairs.map(([covered, total]) => ({ case_id: id, covered, total }));

  it('pools over cases of different sizes (covered sum / total sum)', () => {
    const perCase: CaseRunRecall[] = [
      { case_id: 'big', covered: 8, total: 10 },
      { case_id: 'small', covered: 1, total: 2 },
    ];
    expect(pooledRecall(perCase)).toEqual({ found: 9, total: 12 });
    expect(ratio(pooledRecall(perCase))).toBeCloseTo(0.75, 5);
  });

  it('worst and best run do not depend on run numbering', () => {
    const forward = runs('x', [[2, 10], [7, 10], [5, 10]]);
    const reversed = [...forward].reverse();
    expect(worstRun(forward)).toEqual(worstRun(reversed));
    expect(bestRun(forward)).toEqual(bestRun(reversed));
    expect(worstRun(forward).covered).toBe(2);
    expect(bestRun(forward).covered).toBe(7);
  });

  it('bandFigure picks worst per case then pools, stable under case order', () => {
    const map = new Map<string, CaseRunRecall[]>([
      ['a', runs('a', [[1, 4], [3, 4]])],
      ['b', runs('b', [[2, 2], [1, 2]])],
    ]);
    const fig = bandFigure(map, worstRun);
    // worst of a = 1/4, worst of b = 1/2 -> pooled 2/6
    expect(fig.pooled).toEqual({ found: 2, total: 6 });
    expect(fig.perCase.map((c) => c.case_id)).toEqual(['a', 'b']);
  });
});
