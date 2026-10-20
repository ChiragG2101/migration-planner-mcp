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

/** Every case folder, with its truth and annotations when present. */
export function loadCases(): LoadedCase[] {
  const out: LoadedCase[] = [];
  for (const id of dirs(casesDir())) {
    const dir = path.join(casesDir(), id);
    const casePath = path.join(dir, 'case.json');
    if (!existsSync(casePath)) continue;
    const kase = Case.parse(JSON.parse(readFileSync(casePath, 'utf8')));
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
