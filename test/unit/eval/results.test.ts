// results.md determinism and annotations (M7 Tests: replay determinism bytes,
// annotations cannot move the headline). renderResults is a pure function of
// its input: no clock, no wall time in the bytes.
import { describe, expect, it } from 'vitest';
import { renderResults, type ResultsInput } from '../../../eval/results.js';
import type { CaseRunRecall } from '../../../eval/metrics.js';

function baseInput(): ResultsInput {
  const engine = new Map<string, CaseRunRecall[]>([
    ['a', [{ case_id: 'a', covered: 5, total: 10 }, { case_id: 'a', covered: 7, total: 10 }]],
    ['b', [{ case_id: 'b', covered: 2, total: 4 }, { case_id: 'b', covered: 3, total: 4 }]],
  ]);
  const baseline = new Map<string, CaseRunRecall[]>([
    ['a', [{ case_id: 'a', covered: 1, total: 10 }, { case_id: 'a', covered: 2, total: 10 }]],
    ['b', [{ case_id: 'b', covered: 0, total: 4 }, { case_id: 'b', covered: 1, total: 4 }]],
  ]);
  return {
    prompt_version: 'v1',
    gates_hash: 'abc123',
    packs: [{ pack: 'nextjs-upgrade', present: true, engine, baseline }],
    pending_cases: [{ id: 'django-x', pack: 'django-upgrade' }],
    removed: [],
    coverage_gaps: ['monorepo + several hops: none'],
    annotations: [],
  };
}

describe('renderResults', () => {
  it('is byte-identical across calls (no clock, no wall time in the bytes)', () => {
    expect(renderResults(baseInput())).toBe(renderResults(baseInput()));
  });

  it('reports the all-case beat result and lists pending and gaps', () => {
    const md = renderResults(baseInput());
    expect(md).toContain('the engine beats the baseline');
    expect(md).toContain('Pending cases');
    expect(md).toContain('django-x');
    expect(md).toContain('monorepo + several hops: none');
  });

  it('an annotation changes only the PR-missed section, not the headline bytes', () => {
    const without = renderResults(baseInput());
    const withAnn = renderResults({ ...baseInput(), annotations: [{ case_id: 'a', finding: 'f1', reason: 'PR forgot the config', reviewer: 'me', date: '2026-10-20' }] });
    // The headline (everything before the PR-missed section) is identical.
    const head = (s: string): string => s.slice(0, s.indexOf('## PR missed'));
    expect(head(withAnn)).toBe(head(without));
    expect(withAnn).toContain('PR forgot the config');
    expect(without).toContain('None.');
  });

  it('renders removed cases from REMOVED.json', () => {
    const md = renderResults({ ...baseInput(), removed: [{ id: 'old-messy', reason: 'unlicensed', pr: '#99' }] });
    expect(md).toContain('old-messy');
    expect(md).toContain('unlicensed');
  });
});
