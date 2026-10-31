// Load committed eval data from disk (M7). Discovers cases, truth, annotations
// and recorded runs under eval/, validating each with the schema. Pure reads
// (no clock, no network); src/ never imports it (INV-40). The caller (runner,
// results) decides what to replay and how to render.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotations, BaselineRun, Case, EngineRun, Removed, Truth, type Annotation } from './schema.js';

export const evalRoot = (): string => path.dirname(fileURLToPath(import.meta.url));
export const casesDir = (): string => path.join(evalRoot(), 'cases');
export const runsDir = (): string => path.join(evalRoot(), 'runs');

const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);

export interface LoadedCase {
  case: Case;
  truth: Truth | null;
  annotations: Annotation[];
}

/**
 * Control characters and line or paragraph separators. The message quotes the
 * folder name and file text (V8's JSON error, Zod's unrecognized keys), and a
 * line break there would let a pack PR's text start its own CI log line, which
 * GitHub Actions reads as a workflow command when it starts with `::`.
 */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const escapeBreaks = (s: string): string => s.replace(BREAKS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A `case.json` that is not JSON or fails the case schema, named by its case folder. Callers fail on it; none skips the case. */
export class CaseRecordInvalid extends Error {
  constructor(
    readonly caseId: string,
    detail: string,
  ) {
    super(escapeBreaks(`case_record_invalid: ${caseId}: eval/cases/${caseId}/case.json ${detail}`));
    this.name = 'CaseRecordInvalid';
  }
}

function parseCase(id: string, casePath: string): Case {
  const text = readFileSync(casePath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CaseRecordInvalid(id, `is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = Case.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new CaseRecordInvalid(id, `fails the case schema: ${issues}`);
  }
  return parsed.data;
}

/** Every case folder, with its truth and annotations when present. Throws `CaseRecordInvalid` on the first bad `case.json`. */
export function loadCases(root: string = casesDir()): LoadedCase[] {
  const out: LoadedCase[] = [];
  for (const id of dirs(root)) {
    const dir = path.join(root, id);
    const casePath = path.join(dir, 'case.json');
    if (!existsSync(casePath)) continue;
    const kase = parseCase(id, casePath);
    const truthPath = path.join(dir, 'truth.json');
    const annPath = path.join(dir, 'annotations.json');
    out.push({
      case: kase,
      truth: existsSync(truthPath) ? Truth.parse(JSON.parse(readFileSync(truthPath, 'utf8'))) : null,
      annotations: existsSync(annPath) ? Annotations.parse(JSON.parse(readFileSync(annPath, 'utf8'))).entries : [],
    });
  }
  return out;
}

/** The committed removed-case list (empty when the file is absent). */
export function loadRemoved(): ReturnType<typeof Removed.parse> {
  const p = path.join(casesDir(), 'REMOVED.json');
  return existsSync(p) ? Removed.parse(JSON.parse(readFileSync(p, 'utf8'))) : [];
}

/** Engine runs of a case under one prompt version: eval/runs/<case>/<promptVersion>/<n>/run.json. */
export function loadEngineRuns(caseId: string, promptVersion: string): EngineRun[] {
  const base = path.join(runsDir(), caseId, promptVersion);
  const out: EngineRun[] = [];
  for (const n of dirs(base)) {
    if (n === 'l1') continue; // L1 sets are separate and never count toward N (D17).
    const p = path.join(base, n, 'run.json');
    if (existsSync(p)) out.push(EngineRun.parse(JSON.parse(readFileSync(p, 'utf8'))));
  }
  return out.sort((a, b) => a.run - b.run);
}

/** Baseline runs of a case: eval/runs/<case>/baseline/<n>/run.json. */
export function loadBaselineRuns(caseId: string): BaselineRun[] {
  const base = path.join(runsDir(), caseId, 'baseline');
  const out: BaselineRun[] = [];
  for (const n of dirs(base)) {
    const p = path.join(base, n, 'run.json');
    if (existsSync(p)) out.push(BaselineRun.parse(JSON.parse(readFileSync(p, 'utf8'))));
  }
  return out.sort((a, b) => a.run - b.run);
}
