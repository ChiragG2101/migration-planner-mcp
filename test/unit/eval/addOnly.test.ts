// Eval add-only check unit tests (M7 Tests: eval add-only). Feeds synthetic
// diffs to the pure core.
import { describe, expect, it } from 'vitest';
import { checkAddOnly, type AddOnlyInput, type PathChange } from '../../../eval/addOnly.js';

const base = (over: Partial<AddOnlyInput>): AddOnlyInput => ({
  changes: [],
  existingCases: new Set(['nextjs-x']),
  existingRunSets: new Set(['nextjs-x/v1', 'nextjs-x/baseline']),
  isPackPR: false,
  removedAdded: new Set(),
  removedEntriesTouched: false,
  casesRemoved: new Set(),
  baselinePromptChanged: false,
  ...over,
});

const ch = (path: string, kind: PathChange['kind']): PathChange => ({ path, kind });

describe('existing cases and runs are frozen', () => {
  it('editing an existing recorded run fails', () => {
    const p = checkAddOnly(base({ changes: [ch('eval/runs/nextjs-x/v1/1/run.json', 'modified')] }));
    expect(p.some((m) => m.includes('recorded runs are add-only'))).toBe(true);
  });

  it('a file added to an existing case folder fails', () => {
    const p = checkAddOnly(base({ changes: [ch('eval/cases/nextjs-x/extra.json', 'added')] }));
    expect(p.some((m) => m.includes("existing case's files are frozen"))).toBe(true);
  });

  it('a run added to an existing set fails', () => {
    const p = checkAddOnly(base({ changes: [ch('eval/runs/nextjs-x/v1/4/run.json', 'added')] }));
    expect(p.some((m) => m.includes('recorded runs are add-only'))).toBe(true);
  });

  it('deleting a single run without removing its case fails', () => {
    const p = checkAddOnly(base({ changes: [ch('eval/runs/nextjs-x/v1/1/run.json', 'deleted')] }));
    expect(p.some((m) => m.includes('without removing its case'))).toBe(true);
  });
});

describe('plain adding passes', () => {
  it('runs under a new prompt version pass', () => {
    const p = checkAddOnly(base({ changes: [ch('eval/runs/nextjs-x/v2/1/run.json', 'added')] }));
    expect(p).toEqual([]);
  });

  it('a first L1 set added to an existing case passes, a later run in it fails', () => {
    expect(checkAddOnly(base({ changes: [ch('eval/runs/nextjs-x/v1/l1/1/stage.json', 'added')] }))).toEqual([]);
    const later = checkAddOnly(base({ existingRunSets: new Set(['nextjs-x/v1', 'nextjs-x/baseline', 'nextjs-x/v1/l1']), changes: [ch('eval/runs/nextjs-x/v1/l1/2/stage.json', 'added')] }));
    expect(later.some((m) => m.includes('recorded runs are add-only'))).toBe(true);
  });

  it('appending to annotations.json passes', () => {
    expect(checkAddOnly(base({ changes: [ch('eval/cases/nextjs-x/annotations.json', 'modified')] }))).toEqual([]);
  });
});

describe('baseline-prompt exception (a)', () => {
  it('a core PR changing the baseline prompt and replacing baseline runs passes', () => {
    const p = checkAddOnly(
      base({
        baselinePromptChanged: true,
        changes: [ch('eval/baseline/prompt.md', 'modified'), ch('eval/runs/nextjs-x/baseline/1/run.json', 'modified')],
      }),
    );
    // Note: replacing an existing baseline set is the exception's purpose, so the run-set rule is relaxed only here.
    expect(p.filter((m) => m.includes('exception (a)'))).toEqual([]);
  });

  it('a baseline-prompt change in a pack PR fails', () => {
    const p = checkAddOnly(base({ baselinePromptChanged: true, isPackPR: true, changes: [ch('eval/baseline/prompt.md', 'modified')] }));
    expect(p.some((m) => m.includes('pack PR'))).toBe(true);
  });

  it('a baseline-prompt PR that also touches an engine run fails', () => {
    const p = checkAddOnly(base({ baselinePromptChanged: true, changes: [ch('eval/baseline/prompt.md', 'modified'), ch('eval/runs/nextjs-x/v2/1/run.json', 'added')] }));
    expect(p.some((m) => m.includes('replaces only baseline runs'))).toBe(true);
  });
});

describe('removal exception (b)', () => {
  it('a case removal with a REMOVED.json entry in a core PR passes', () => {
    const p = checkAddOnly(
      base({
        casesRemoved: new Set(['nextjs-x']),
        removedAdded: new Set(['nextjs-x']),
        changes: [ch('eval/cases/nextjs-x/case.json', 'deleted'), ch('eval/runs/nextjs-x/v1/1/run.json', 'deleted'), ch('eval/cases/REMOVED.json', 'modified')],
      }),
    );
    expect(p).toEqual([]);
  });

  it('a removal with no REMOVED.json entry fails', () => {
    const p = checkAddOnly(base({ casesRemoved: new Set(['nextjs-x']), changes: [ch('eval/cases/nextjs-x/case.json', 'deleted')] }));
    expect(p.some((m) => m.includes('no eval/cases/REMOVED.json entry'))).toBe(true);
  });

  it('a removal in a pack PR fails', () => {
    const p = checkAddOnly(base({ casesRemoved: new Set(['nextjs-x']), removedAdded: new Set(['nextjs-x']), isPackPR: true, changes: [ch('eval/cases/nextjs-x/case.json', 'deleted')] }));
    expect(p.some((m) => m.includes('removal is a core PR only'))).toBe(true);
  });

  it('a REMOVED.json entry with no matching removal fails', () => {
    const p = checkAddOnly(base({ removedAdded: new Set(['ghost']), changes: [ch('eval/cases/REMOVED.json', 'modified')] }));
    expect(p.some((m) => m.includes('no matching case removal'))).toBe(true);
  });

  it('editing an existing REMOVED.json entry fails', () => {
    const p = checkAddOnly(base({ removedEntriesTouched: true, changes: [ch('eval/cases/REMOVED.json', 'modified')] }));
    expect(p.some((m) => m.includes('entries are frozen'))).toBe(true);
  });
});
