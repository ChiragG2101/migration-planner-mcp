// Gate 7: test integrity (M8, D45). Compares the test suite in the sandbox
// after a stage patch against the baseline (the unmodified clone). Fails the
// stage on:
//   - fewer test cases (it/test calls)
//   - fewer assertion calls (expect/assert)
//   - new skip/only/xfail markers
//   - deleted test files
//   - deleted snapshot files
//   - lowered coverage thresholds (vitest/jest config)
//   - changed check definitions (vitest.config / jest.config)
//
// Uses the TypeScript compiler API for TS/JS (D45) and tree-sitter WASM for
// Python. Falls back to a simple regex counter when the TS API is unavailable
// (e.g. in tests that don't load the full engine).
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { Language, Parser } from 'web-tree-sitter';
import { existsSandbox, readdirSandboxWithTypes, readBytesSandbox, statSandbox } from '../security/safeRead.js';
import { resolveInside } from '../security/pathBoundary.js';
import { GRAMMAR_PATH } from '../lang/python/parser.js';
import type { Gate7Result } from '../schema/verify.js';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /__tests__\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.test\.py$/,
  /test_.*\.py$/,
];

const SNAPSHOT_EXTENSIONS = new Set(['.snap', '.snapshot']);

function isTestFile(p: string): boolean {
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

function isSnapshotFile(p: string): boolean {
  return SNAPSHOT_EXTENSIONS.has(path.extname(p));
}

function walkDir(dir: string, out: string[] = []): string[] {
  if (!existsSandbox(dir)) return out;
  for (const entry of readdirSandboxWithTypes(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkDir(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TS/JS test counting via TypeScript compiler API
// ---------------------------------------------------------------------------

// Call expressions that count as test cases (TS/JS). `describe` blocks are
// counted too (plan task 7): a dropped describe hides every test under it.
const TEST_CASE_NAMES = new Set([
  'it', 'test', 'it.concurrent', 'test.concurrent', 'it.each', 'test.each',
  'describe', 'describe.each', 'suite',
]);
// Call expressions / markers that count as skipped, focused or pending (TS/JS).
const SKIP_NAMES = new Set([
  'it.skip', 'test.skip', 'describe.skip', 'suite.skip',
  'it.only', 'test.only', 'describe.only', 'suite.only',
  'xit', 'xtest', 'xdescribe', 'fit', 'fdescribe',
  'it.todo', 'test.todo',
]);
// Assertion call names (TS/JS).
const ASSERT_NAMES = new Set([
  'expect', 'assert', 'assertEqual', 'assertTrue', 'assertFalse', 'expectTypeOf',
]);

interface TestCounts {
  testCases: number;
  assertions: number;
  skips: number;
}

/**
 * Count tests, assertions and skip markers in a TS/JS source using the
 * TypeScript compiler API (D45): real call-expression nodes, so a name inside
 * a string or comment never counts. `it.skip(...)` matches both the test-case
 * name (`it`) and the skip name, so a skip adds to both counts, which is what
 * we want — a `.skip` is a disabled test case.
 */
function countTestsTs(filePath: string, source: string): TestCounts {
  const kind = /\.(tsx|jsx)$/.test(filePath)
    ? ts.ScriptKind.TSX
    : /\.(js|mjs|cjs)$/.test(filePath)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
  let testCases = 0;
  let assertions = 0;
  let skips = 0;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      // A test/skip case is a call whose callee is an identifier (`it(...)`) or
      // a direct property of one (`it.skip(...)`, `describe.each(...)`). A deeper
      // chain like `expect(x).toBe(y)` is not a case; its callee base must be the
      // identifier right under the call.
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        const name = expr.getText(sf);
        if (TEST_CASE_NAMES.has(name)) testCases++;
        if (ASSERT_NAMES.has(name)) assertions++; // `expect(...)`, `assert(...)`
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        const callee = `${expr.expression.getText(sf)}.${expr.name.getText(sf)}`;
        const base = expr.expression.getText(sf);
        if (TEST_CASE_NAMES.has(callee) || TEST_CASE_NAMES.has(base)) testCases++;
        if (SKIP_NAMES.has(callee)) skips++;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { testCases, assertions, skips };
}

// ---------------------------------------------------------------------------
// Python test counting via tree-sitter WASM (the M2 grammar, D45)
// ---------------------------------------------------------------------------

let pyParser: Parser | null = null;

/** Initialise the vendored Python grammar once (shared with the M2 adapter). */
async function initPyParser(): Promise<Parser> {
  if (pyParser) return pyParser;
  await Parser.init();
  const lang = await Language.load(GRAMMAR_PATH);
  const p = new Parser();
  p.setLanguage(lang);
  pyParser = p;
  return p;
}

// unittest TestCase assertion methods and bare assert.
const PY_ASSERT_METHODS = /^assert[A-Z]/; // assertEqual, assertTrue, assertIn, ...

/**
 * Count Python test cases, assertions and skips from the syntax tree:
 *   - test cases: top-level `def test_*` and methods `def test_*` inside a
 *     `TestCase` subclass
 *   - assertions: `assert` statements, and `self.assert*(...)` calls
 *   - skips: `@pytest.mark.skip` / `.skipif` / `.xfail` and `@unittest.skip*`
 *     decorators, and `pytest.skip(...)` / `self.skipTest(...)` calls
 */
function countTestsPy(source: string, parser: Parser): TestCounts {
  const tree = parser.parse(source);
  if (!tree) return { testCases: 0, assertions: 0, skips: 0 };
  let testCases = 0;
  let assertions = 0;
  let skips = 0;

  type N = ReturnType<Parser['parse']> extends infer T ? (T extends { rootNode: infer R } ? R : never) : never;
  const walk = (node: NonNullable<N>): void => {
    const type = node.type;
    if (type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? '';
      if (name.startsWith('test')) testCases++;
    } else if (type === 'assert_statement') {
      assertions++;
    } else if (type === 'call') {
      const fn = node.childForFieldName('function');
      const fnText = fn?.text ?? '';
      // self.assertEqual(...), self.assertTrue(...), etc.
      const lastAttr = fnText.includes('.') ? fnText.slice(fnText.lastIndexOf('.') + 1) : fnText;
      if (PY_ASSERT_METHODS.test(lastAttr)) assertions++;
      // In-body skips only. `pytest.mark.skip(...)` is caught by the decorator
      // rule, so it is excluded here to avoid double counting.
      if ((fnText === 'pytest.skip' || fnText.endsWith('.skipTest') || fnText === 'skipTest') && !fnText.includes('.mark.')) {
        skips++;
      }
    } else if (type === 'decorator') {
      const text = node.text;
      if (/pytest\.mark\.(skip|skipif|xfail)/.test(text) || /unittest\.skip/.test(text) || /@skip\b/.test(text)) {
        skips++;
      }
    }
    for (const child of node.children) if (child) walk(child);
  };
  walk(tree.rootNode as NonNullable<N>);
  tree.delete();
  return { testCases, assertions, skips };
}

function readFileSandboxRaw(abs: string): Buffer {
  return readBytesSandbox(resolveInside(path.dirname(abs), path.basename(abs), null));
}

function readFileSandboxText(abs: string): string {
  return readFileSandboxRaw(abs).toString('utf8');
}

// ---------------------------------------------------------------------------
// Coverage threshold extraction
// ---------------------------------------------------------------------------

const COVERAGE_KEYS = ['lines', 'functions', 'branches', 'statements', 'fail_under'];

function extractCoverageThresholds(source: string): Record<string, number> {
  const thresholds: Record<string, number> = {};
  for (const key of COVERAGE_KEYS) {
    // JS config `lines: 80`, Python `fail_under = 80` or `--cov-fail-under=80`.
    const match = new RegExp(`['"]?${key}['"]?\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)`).exec(source);
    if (match) thresholds[key] = parseFloat(match[1]!);
    const cli = new RegExp(`--cov-fail-under[= ](\\d+(?:\\.\\d+)?)`).exec(source);
    if (key === 'fail_under' && cli) thresholds[key] = parseFloat(cli[1]!);
  }
  return thresholds;
}

// Files that define the declared checks or the test selection. A change to any
// of these is a check-definition change (gate 7 rule changed_check_definition),
// because it can silently deselect or reconfigure tests (plan task 7).
function isConfigFile(p: string): boolean {
  const base = path.basename(p);
  return (
    /^(vitest|jest)\.config\.(ts|js|mjs|cjs|json)$/.test(base) ||
    /^(pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/.test(base) ||
    base === 'pyproject.toml'
  );
}

/**
 * The parts of package.json that define checks: the `scripts` block and any
 * `coverageThreshold` under a `jest` key. We hash only these so an unrelated
 * dependency bump in the same file does not trip gate 7.
 */
function packageJsonCheckDigest(source: string): string {
  try {
    const pkg = JSON.parse(source) as Record<string, unknown>;
    const relevant = {
      scripts: pkg.scripts ?? {},
      jest: (pkg.jest as Record<string, unknown> | undefined)?.coverageThreshold ?? {},
    };
    return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
  } catch {
    return createHash('sha256').update(source).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Snapshot hash
// ---------------------------------------------------------------------------

function fileHash(p: string): string {
  try {
    return createHash('sha256').update(readFileSandboxRaw(p)).digest('hex');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TestSnapshot {
  /** Relative path → TestCounts */
  tests: Map<string, TestCounts>;
  /** Relative path → sha256 */
  snapshots: Map<string, string>;
  /** Relative path → coverage thresholds */
  coverageThresholds: Map<string, Record<string, number>>;
  /** Relative path → file hash (for check definition change detection) */
  configHashes: Map<string, string>;
}

/**
 * Snapshot the test state of a directory. Async because Python counting loads
 * the tree-sitter grammar (the same vendored grammar the M2 adapter uses).
 */
export async function snapshotTests(dir: string): Promise<TestSnapshot> {
  const tests = new Map<string, TestCounts>();
  const snapshots = new Map<string, string>();
  const coverageThresholds = new Map<string, Record<string, number>>();
  const configHashes = new Map<string, string>();

  let parser: Parser | null = null;

  for (const abs of walkDir(dir)) {
    const rel = path.relative(dir, abs);
    if (isTestFile(abs)) {
      const src = readFileSandboxText(abs);
      if (abs.endsWith('.py')) {
        parser ??= await initPyParser();
        tests.set(rel, countTestsPy(src, parser));
      } else {
        tests.set(rel, countTestsTs(abs, src));
      }
    }
    if (isSnapshotFile(abs)) {
      snapshots.set(rel, fileHash(abs));
    }
    if (isConfigFile(abs)) {
      const src = readFileSandboxText(abs);
      coverageThresholds.set(rel, extractCoverageThresholds(src));
      configHashes.set(rel, fileHash(abs));
    }
    if (path.basename(abs) === 'package.json') {
      const src = readFileSandboxText(abs);
      coverageThresholds.set(rel, extractCoverageThresholds(src));
      configHashes.set(rel, packageJsonCheckDigest(src));
    }
  }
  return { tests, snapshots, coverageThresholds, configHashes };
}

/**
 * Compare `after` (post-patch) against `before` (baseline). Returns a Gate7Result.
 * Fails on any of the seven rules (D45).
 */
export function checkTestIntegrity(before: TestSnapshot, after: TestSnapshot): Gate7Result {
  const violations: Gate7Result['violations'] = [];

  // Rule: deleted test file
  for (const [rel] of before.tests) {
    if (!after.tests.has(rel)) {
      violations.push({ rule: 'deleted_test_file', file: rel, detail: `test file deleted: ${rel}` });
    }
  }

  // Rule: fewer test cases / fewer assertions / new skip marker
  for (const [rel, bCounts] of before.tests) {
    const aCounts = after.tests.get(rel);
    if (!aCounts) continue; // already reported as deleted
    if (aCounts.testCases < bCounts.testCases) {
      violations.push({
        rule: 'fewer_test_cases',
        file: rel,
        detail: `test cases: ${bCounts.testCases} → ${aCounts.testCases}`,
      });
    }
    if (aCounts.assertions < bCounts.assertions) {
      violations.push({
        rule: 'fewer_assertions',
        file: rel,
        detail: `assertions: ${bCounts.assertions} → ${aCounts.assertions}`,
      });
    }
    if (aCounts.skips > bCounts.skips) {
      violations.push({
        rule: 'new_skip_marker',
        file: rel,
        detail: `skip markers: ${bCounts.skips} → ${aCounts.skips}`,
      });
    }
  }

  // Rule: deleted snapshot
  for (const [rel] of before.snapshots) {
    if (!after.snapshots.has(rel)) {
      violations.push({ rule: 'deleted_snapshot', file: rel, detail: `snapshot deleted: ${rel}` });
    }
  }

  // Rule: lowered coverage threshold
  for (const [rel, bThresh] of before.coverageThresholds) {
    const aThresh = after.coverageThresholds.get(rel) ?? {};
    for (const key of COVERAGE_KEYS) {
      const bVal = bThresh[key];
      const aVal = aThresh[key];
      if (bVal !== undefined && aVal !== undefined && aVal < bVal) {
        violations.push({
          rule: 'lowered_coverage_threshold',
          file: rel,
          detail: `coverage.${key}: ${bVal} → ${aVal}`,
        });
      }
    }
  }

  // Rule: changed check definition (config file hash changed)
  for (const [rel, bHash] of before.configHashes) {
    const aHash = after.configHashes.get(rel);
    if (aHash !== undefined && aHash !== bHash) {
      violations.push({
        rule: 'changed_check_definition',
        file: rel,
        detail: `check config changed: ${rel}`,
      });
    }
  }

  return { pass: violations.length === 0, violations };
}

/** Convenience: snapshot both trees and compare. Used by the loop and tests. */
export async function checkIntegrityAfterPatch(beforeDir: string, afterDir: string): Promise<Gate7Result> {
  const before = await snapshotTests(beforeDir);
  const after = await snapshotTests(afterDir);
  return checkTestIntegrity(before, after);
}

// Re-export for callers that only need the stat helper.
export { statSandbox as statSandboxFile };
