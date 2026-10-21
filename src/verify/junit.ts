// JUnit XML parsing (M8, plan tasks 4 & 6). When a check declares a JUnit
// output path, we read the XML the runner wrote and extract per-test results
// so the agent sees failing test names, not just an exit code. The parse is a
// small regex scan — JUnit XML is simple and we only need counts and names,
// not a full DOM. No external XML dependency.
import type { JUnitSummary } from '../schema/verify.js';

/**
 * Parse a JUnit XML string into a summary. Handles the common shapes written
 * by Vitest, Jest (jest-junit) and pytest: <testsuites>/<testsuite> with
 * `tests`/`failures`/`errors`/`skipped` attributes and <testcase> children
 * whose failures/errors are nested elements.
 */
export function parseJUnit(xml: string): JUnitSummary {
  // Prefer the aggregate attributes on the outermost testsuite(s) when present.
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;

  const suiteAttrRe = /<testsuites?\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  let sawSuiteAggregate = false;
  // Only take the first <testsuites> (aggregate) if it has the counts; else sum <testsuite>.
  const topMatch = /<testsuites\b([^>]*)>/.exec(xml);
  if (topMatch && /\btests\s*=/.test(topMatch[1]!)) {
    tests = attrInt(topMatch[1]!, 'tests');
    failures = attrInt(topMatch[1]!, 'failures');
    errors = attrInt(topMatch[1]!, 'errors');
    skipped = attrInt(topMatch[1]!, 'skipped');
    sawSuiteAggregate = true;
  } else {
    while ((m = suiteAttrRe.exec(xml)) !== null) {
      const attrs = m[1]!;
      if (/\btests\s*=/.test(attrs)) {
        tests += attrInt(attrs, 'tests');
        failures += attrInt(attrs, 'failures');
        errors += attrInt(attrs, 'errors');
        skipped += attrInt(attrs, 'skipped');
        sawSuiteAggregate = true;
      }
    }
  }

  // Collect failing test-case names by scanning <testcase> blocks.
  const failing: string[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let caseCount = 0;
  let caseFail = 0;
  let caseError = 0;
  let caseSkip = 0;
  let c: RegExpExecArray | null;
  while ((c = caseRe.exec(xml)) !== null) {
    caseCount++;
    const attrs = c[1]!;
    const body = c[3] ?? '';
    const name = attrStr(attrs, 'name');
    const classname = attrStr(attrs, 'classname');
    const full = classname ? `${classname} › ${name}` : name;
    if (/<failure\b/.test(body)) {
      caseFail++;
      failing.push(full);
    } else if (/<error\b/.test(body)) {
      caseError++;
      failing.push(full);
    } else if (/<skipped\b/.test(body)) {
      caseSkip++;
    }
  }

  // If no aggregate attributes were present, derive counts from the cases.
  if (!sawSuiteAggregate) {
    tests = caseCount;
    failures = caseFail;
    errors = caseError;
    skipped = caseSkip;
  }

  return { tests, failures, errors, skipped, failing };
}

function attrInt(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*"(\\d+)"`).exec(attrs);
  return m ? parseInt(m[1]!, 10) : 0;
}

function attrStr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1]! : '';
}
