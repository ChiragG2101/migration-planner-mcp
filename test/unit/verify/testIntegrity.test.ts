// Gate 7 unit tests (M8, INV-52 to INV-58). Each test removes one guard and
// confirms the gate fires. Tests use in-memory snapshots — no disk I/O.
import { describe, expect, it } from 'vitest';
import { checkTestIntegrity, snapshotTests, type TestSnapshot } from '../../../src/verify/testIntegrity.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<TestSnapshot> = {}): TestSnapshot {
  return {
    tests: new Map(),
    snapshots: new Map(),
    coverageThresholds: new Map(),
    configHashes: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deleted_test_file
// ---------------------------------------------------------------------------

describe('gate 7: deleted_test_file', () => {
  it('passes when test files are identical', () => {
    const before = makeSnapshot({ tests: new Map([['src/foo.test.ts', { testCases: 2, assertions: 4, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['src/foo.test.ts', { testCases: 2, assertions: 4, skips: 0 }]]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });

  it('fails when a test file is deleted', () => {
    const before = makeSnapshot({ tests: new Map([['src/foo.test.ts', { testCases: 2, assertions: 4, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map() });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('deleted_test_file');
  });

  it('removing the deleted_test_file check would make this test fail', () => {
    // This is the guard test: if we remove the check, the violation count is 0.
    const before = makeSnapshot({ tests: new Map([['src/foo.test.ts', { testCases: 1, assertions: 1, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map() });
    const result = checkTestIntegrity(before, after);
    expect(result.violations.some((v) => v.rule === 'deleted_test_file')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fewer_test_cases
// ---------------------------------------------------------------------------

describe('gate 7: fewer_test_cases', () => {
  it('passes when test case count is unchanged', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 0 }]]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });

  it('fails when test cases decrease', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 2, assertions: 6, skips: 0 }]]) });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('fewer_test_cases');
  });

  it('passes when test cases increase', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 2, assertions: 4, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 4, skips: 0 }]]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fewer_assertions
// ---------------------------------------------------------------------------

describe('gate 7: fewer_assertions', () => {
  it('fails when assertions decrease', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 2, assertions: 6, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 2, assertions: 4, skips: 0 }]]) });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('fewer_assertions');
  });
});

// ---------------------------------------------------------------------------
// new_skip_marker
// ---------------------------------------------------------------------------

describe('gate 7: new_skip_marker', () => {
  it('fails when skip count increases', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 0 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 1 }]]) });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('new_skip_marker');
  });

  it('passes when skip count is unchanged', () => {
    const before = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 1 }]]) });
    const after = makeSnapshot({ tests: new Map([['a.test.ts', { testCases: 3, assertions: 6, skips: 1 }]]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleted_snapshot
// ---------------------------------------------------------------------------

describe('gate 7: deleted_snapshot', () => {
  it('fails when a snapshot is deleted', () => {
    const before = makeSnapshot({ snapshots: new Map([['__snapshots__/foo.test.ts.snap', 'abc123']]) });
    const after = makeSnapshot({ snapshots: new Map() });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('deleted_snapshot');
  });

  it('passes when snapshot is unchanged', () => {
    const before = makeSnapshot({ snapshots: new Map([['__snapshots__/foo.test.ts.snap', 'abc123']]) });
    const after = makeSnapshot({ snapshots: new Map([['__snapshots__/foo.test.ts.snap', 'abc123']]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lowered_coverage_threshold
// ---------------------------------------------------------------------------

describe('gate 7: lowered_coverage_threshold', () => {
  it('fails when a coverage threshold is lowered', () => {
    const before = makeSnapshot({ coverageThresholds: new Map([['vitest.config.ts', { lines: 80, branches: 70 }]]) });
    const after = makeSnapshot({ coverageThresholds: new Map([['vitest.config.ts', { lines: 70, branches: 70 }]]) });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('lowered_coverage_threshold');
  });

  it('passes when threshold is raised', () => {
    const before = makeSnapshot({ coverageThresholds: new Map([['vitest.config.ts', { lines: 80 }]]) });
    const after = makeSnapshot({ coverageThresholds: new Map([['vitest.config.ts', { lines: 90 }]]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// changed_check_definition
// ---------------------------------------------------------------------------

describe('gate 7: changed_check_definition', () => {
  it('fails when a config file hash changes', () => {
    const before = makeSnapshot({ configHashes: new Map([['vitest.config.ts', 'hash1']]) });
    const after = makeSnapshot({ configHashes: new Map([['vitest.config.ts', 'hash2']]) });
    const result = checkTestIntegrity(before, after);
    expect(result.pass).toBe(false);
    expect(result.violations[0]?.rule).toBe('changed_check_definition');
  });

  it('passes when config file is unchanged', () => {
    const before = makeSnapshot({ configHashes: new Map([['vitest.config.ts', 'hash1']]) });
    const after = makeSnapshot({ configHashes: new Map([['vitest.config.ts', 'hash1']]) });
    expect(checkTestIntegrity(before, after).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// snapshotTests — disk-based integration
// ---------------------------------------------------------------------------

describe('snapshotTests', () => {
  it('finds test files and counts calls (TS compiler API, not regex)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-'));
    try {
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(
        path.join(dir, 'src', 'foo.test.ts'),
        // A name inside a string must NOT count — this is the regex trap.
        `import { it, expect, describe } from 'vitest';\n` +
          `const note = 'it("fake") expect(0)';\n` +
          `describe('g', () => {\n  it('works', () => { expect(1).toBe(1); });\n  it('two', () => { expect(2).toBe(2); });\n});\n`,
      );
      const snap = await snapshotTests(dir);
      const counts = snap.tests.get('src/foo.test.ts');
      expect(counts).toBeDefined();
      // 2 it() + 1 describe() = 3 cases; the string "it(...)" is not counted.
      expect(counts!.testCases).toBe(3);
      expect(counts!.assertions).toBe(2);
      expect(counts!.skips).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a .skip as both a case and a skip', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-skip-'));
    try {
      writeFileSync(
        path.join(dir, 'a.test.ts'),
        `import { it, expect } from 'vitest';\nit.skip('later', () => { expect(1).toBe(1); });\n`,
      );
      const snap = await snapshotTests(dir);
      const counts = snap.tests.get('a.test.ts')!;
      expect(counts.skips).toBe(1);
      expect(counts.testCases).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts Python tests, assertions and skips via tree-sitter', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-py-'));
    try {
      writeFileSync(
        path.join(dir, 'test_math.py'),
        [
          'import pytest',
          'import unittest',
          '',
          'def test_add():',
          '    assert 1 + 1 == 2',
          '',
          '@pytest.mark.skip(reason="later")',
          'def test_skipped():',
          '    assert True',
          '',
          'class TestThings(unittest.TestCase):',
          '    def test_eq(self):',
          '        self.assertEqual(1, 1)',
          '',
        ].join('\n'),
      );
      const snap = await snapshotTests(dir);
      const counts = snap.tests.get('test_math.py')!;
      expect(counts.testCases).toBe(3); // test_add, test_skipped, test_eq
      expect(counts.assertions).toBe(3); // 2 asserts + 1 self.assertEqual
      expect(counts.skips).toBe(1); // @pytest.mark.skip
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds snapshot files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-snap-'));
    try {
      mkdirSync(path.join(dir, '__snapshots__'), { recursive: true });
      writeFileSync(path.join(dir, '__snapshots__', 'foo.test.ts.snap'), 'exports[`foo 1`] = `"bar"`;');
      const snap = await snapshotTests(dir);
      expect(snap.snapshots.has('__snapshots__/foo.test.ts.snap')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds coverage thresholds in vitest config', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-cov-'));
    try {
      writeFileSync(
        path.join(dir, 'vitest.config.ts'),
        `export default { test: { coverage: { lines: 80, branches: 70 } } }`,
      );
      const snap = await snapshotTests(dir);
      const thresholds = snap.coverageThresholds.get('vitest.config.ts');
      expect(thresholds).toBeDefined();
      expect(thresholds!['lines']).toBe(80);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a changed package.json test script but ignores an unrelated dep bump', async () => {
    const before = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-pkg-b-'));
    const afterScript = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-pkg-s-'));
    const afterDep = mkdtempSync(path.join(os.tmpdir(), 'mp-gate7-pkg-d-'));
    try {
      writeFileSync(path.join(before, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { a: '1.0.0' } }));
      writeFileSync(path.join(afterScript, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run src/only' }, dependencies: { a: '1.0.0' } }));
      writeFileSync(path.join(afterDep, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { a: '2.0.0' } }));
      const b = await snapshotTests(before);
      const s = await snapshotTests(afterScript);
      const d = await snapshotTests(afterDep);
      // We compare config hashes keyed by the same rel path; both dirs use package.json.
      expect(b.configHashes.get('package.json')).not.toBe(s.configHashes.get('package.json'));
      expect(b.configHashes.get('package.json')).toBe(d.configHashes.get('package.json'));
    } finally {
      for (const d of [before, afterScript, afterDep]) rmSync(d, { recursive: true, force: true });
    }
  });
});
