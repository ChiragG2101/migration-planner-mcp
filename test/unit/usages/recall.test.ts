// The smoke eval before M7: recall on each seeded repo is at or above its
// floor in eval/seeded/ratchet.json and recall.md is current. The ratchet
// rules (only up; a new floor equals the measured recall) are tested on
// synthetic results; CI runs the same check against the PR base.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkProblems, measure, ratio, readRatchet, seededRepos, type RecallResult } from '../../../eval/seeded/recall.js';
import { repoRoot } from '../../helpers.js';

const recallMd = (): string => readFileSync(path.join(repoRoot, 'eval/seeded/recall.md'), 'utf8');

describe('seeded recall', () => {
  it('every seeded repo meets its floor, and recall.md is current', async () => {
    const results: RecallResult[] = [];
    for (const repo of seededRepos()) results.push(await measure(repo));
    expect(results.map((r) => r.repo)).toContain('next-tricky');
    expect(checkProblems(results, readRatchet(), recallMd(), null)).toEqual([]);
  });

  it('next-tricky: 100% on direct usages and at least 80% on indirect ones (the M2 target)', async () => {
    const r = await measure('next-tricky');
    expect(ratio(r.direct)).toBe(1);
    expect(ratio(r.indirect)).toBeGreaterThanOrEqual(0.8);
    expect(r.indirect.total).toBeGreaterThanOrEqual(3);
  });
});

describe('ratchet rules', () => {
  const result = (found: number, total: number, repo = 'demo'): RecallResult => ({
    repo,
    adapter: 'x@1',
    library: 'x',
    source: '1',
    target: '2',
    overall: { found, total },
    direct: { found, total },
    indirect: { found: 0, total: 0 },
    byKind: {},
    misses: [],
    decoysWithUsage: [],
  });
  // recall.md is passed as null, so its staleness is filtered out and only the rule under test shows.
  const only = (problems: string[]): string[] => problems.filter((p) => !p.includes('recall.md'));

  it('fails when recall drops below the floor', () => {
    expect(only(checkProblems([result(8, 10)], { demo: { overall: 0.9 } }, null, null))).toEqual([
      'demo: recall 0.8000 is below its floor 0.9000',
    ]);
    expect(only(checkProblems([result(9, 10)], { demo: { overall: 0.9 } }, null, null))).toEqual([]);
  });

  it('fails when a seeded repo has no floor', () => {
    expect(only(checkProblems([result(9, 10)], {}, null, null))).toEqual(['demo: no floor in ratchet.json (a new entry starts at the measured 0.9000)']);
  });

  it('fails when a change lowers or removes a floor', () => {
    expect(only(checkProblems([result(10, 10)], { demo: { overall: 0.8 } }, null, { demo: { overall: 0.9 } }))).toEqual([
      'demo: floor lowered from 0.9000 to 0.8000; the ratchet only moves up',
    ]);
    expect(only(checkProblems([result(10, 10)], { demo: { overall: 1 } }, null, { demo: { overall: 1 }, gone: { overall: 1 } }))).toEqual([
      'gone: its floor was removed from ratchet.json',
    ]);
    expect(only(checkProblems([result(10, 10)], { demo: { overall: 1 } }, null, { demo: { overall: 0.9 } }))).toEqual([]);
  });

  it('fails when a new floor does not equal the measured recall', () => {
    expect(only(checkProblems([result(9, 10)], { demo: { overall: 0.5 } }, null, {}))).toEqual([
      'demo: a new floor must equal the measured recall 0.9000, not 0.5000',
    ]);
    expect(only(checkProblems([result(9, 10)], { demo: { overall: 0.9 } }, null, {}))).toEqual([]);
  });

  it('fails when recall.md is stale', () => {
    expect(checkProblems([result(1, 1)], { demo: { overall: 1 } }, 'old text', null)).toEqual([
      'eval/seeded/recall.md is stale: run `npm run recall` and commit it',
    ]);
  });
});
