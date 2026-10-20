// Truth derivation tests (M7 Tests: truth derivation). Exercises the pure core
// on hand-made diffs plus synthetic usages, and the diff/numstat parsers.
import { describe, expect, it } from 'vitest';
import { deriveTruthFrom, isLockfile, parseDiffHunks, parseNumstat } from '../../../scripts/derive-truth.js';
import type { Usage } from '../../../src/schema/usage.js';

const usage = (file: string, start: number, end: number, hash: string): Usage => ({
  id: `${file}:${start}`,
  repo_id: 'r',
  file,
  line_start: start,
  line_end: end,
  snippet_hash: hash.padEnd(64, '0'),
  kind: 'call',
  symbol: 'cookies',
  module: 'next/headers',
  match_kind: 'call',
  context: '',
  via: [],
  confidence: 'exact',
  labels: [],
});

describe('diff parsing', () => {
  it('parses base-side hunk ranges and skips pure insertions', () => {
    const diff = [
      '--- a/app/page.tsx',
      '+++ b/app/page.tsx',
      '@@ -10,2 +10,3 @@',
      '@@ -20,0 +25,4 @@', // pure insertion at base -> skipped
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,5 @@',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual([{ file: 'app/page.tsx', start: 10, end: 11 }]);
  });

  it('numstat sums added+removed per file, excluding lockfiles', () => {
    const numstat = ['5\t3\tapp/page.tsx', '100\t50\tpackage-lock.json', '2\t0\tlib/db.ts'].join('\n');
    expect(parseNumstat(numstat)).toEqual({ 'app/page.tsx': 8, 'lib/db.ts': 2 });
  });

  it('knows the lockfiles', () => {
    expect(isLockfile('a/package-lock.json')).toBe(true);
    expect(isLockfile('pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('app/page.tsx')).toBe(false);
  });
});

describe('deriveTruthFrom', () => {
  it('maps changed hunks to base usages by overlap, carries their spans and hashes', () => {
    const usages = [usage('app/page.tsx', 10, 11, 'aa'), usage('app/other.tsx', 5, 5, 'bb')];
    const diff = ['--- a/app/page.tsx', '+++ b/app/page.tsx', '@@ -10,2 +10,2 @@'].join('\n');
    const numstat = ['4\t2\tapp/page.tsx', '200\t0\tpackage-lock.json'].join('\n');
    const truth = deriveTruthFrom({ caseId: 'c', baseCommit: 'b', mergeCommit: 'm', usages, diffUnified0: diff, numstat });
    expect(truth.changed_usages).toEqual([{ file: 'app/page.tsx', line_start: 10, line_end: 11, snippet_hash: 'aa'.padEnd(64, '0') }]);
    expect(truth.touched_files).toEqual(['app/page.tsx']);
    expect(truth.edit_size).toEqual({ 'app/page.tsx': 6 });
  });

  it('drops a second usage that shares file, span and snippet_hash', () => {
    const first = usage('yarn.lock', 7727, 7727, 'aa');
    const dup = { ...usage('yarn.lock', 7727, 7727, 'aa'), id: 'dup', symbol: 'other' };
    const other = usage('yarn.lock', 9885, 9885, 'bb');
    const diff = ['--- a/yarn.lock', '+++ b/yarn.lock', '@@ -7727,1 +7727,1 @@', '@@ -9885,1 +9885,1 @@'].join('\n');
    const truth = deriveTruthFrom({ caseId: 'c', baseCommit: 'b', mergeCommit: 'm', usages: [first, dup, other], diffUnified0: diff, numstat: '' });
    expect(truth.changed_usages).toEqual([
      { file: 'yarn.lock', line_start: 7727, line_end: 7727, snippet_hash: 'aa'.padEnd(64, '0') },
      { file: 'yarn.lock', line_start: 9885, line_end: 9885, snippet_hash: 'bb'.padEnd(64, '0') },
    ]);
    expect(truth.touched_files).toEqual([]);
  });

  it('keeps two usages on the same span when their snippet hashes differ, and an empty usage list stays empty', () => {
    const left = usage('app/page.tsx', 10, 10, 'aa');
    const right = usage('app/page.tsx', 10, 10, 'bb');
    const diff = ['--- a/app/page.tsx', '+++ b/app/page.tsx', '@@ -10,1 +10,1 @@'].join('\n');
    const truth = deriveTruthFrom({ caseId: 'c', baseCommit: 'b', mergeCommit: 'm', usages: [left, right], diffUnified0: diff, numstat: '1\t1\tapp/page.tsx' });
    expect(truth.changed_usages.map((u) => u.snippet_hash)).toEqual(['aa'.padEnd(64, '0'), 'bb'.padEnd(64, '0')]);
    const none = deriveTruthFrom({ caseId: 'c', baseCommit: 'b', mergeCommit: 'm', usages: [], diffUnified0: diff, numstat: '' });
    expect(none.changed_usages).toEqual([]);
  });

  it('excludes files with no base usage from the truth usages but keeps them in touched_files', () => {
    const usages = [usage('app/page.tsx', 10, 11, 'aa')];
    const diff = ['--- a/app/page.tsx', '+++ b/app/page.tsx', '@@ -10,1 +10,1 @@', '--- a/README.md', '+++ b/README.md', '@@ -1,1 +1,1 @@'].join('\n');
    const truth = deriveTruthFrom({ caseId: 'c', baseCommit: 'b', mergeCommit: 'm', usages, diffUnified0: diff, numstat: '' });
    expect(truth.changed_usages.length).toBe(1);
    expect(truth.touched_files).toEqual(['README.md', 'app/page.tsx']);
  });
});
