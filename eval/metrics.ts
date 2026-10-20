// Eval metrics (M7 task 5). All PRD section 10 metrics, computed from a
// replayed engine run or a re-scored baseline run against a case's truth (or a
// seeded repo's ground truth). Pure functions: no I/O, no clock, no network.
// Cost and wall time come from the recorded run and are never measured here.
import type { UsageSpan } from './schema.js';

/** A span matches a truth usage by file, span and snippet_hash, never by usage ID (D17). */
export function sameSpan(a: UsageSpan, b: UsageSpan): boolean {
  return a.file === b.file && a.line_start === b.line_start && a.line_end === b.line_end && a.snippet_hash === b.snippet_hash;
}

export interface Tally {
  found: number;
  total: number;
}
export const ratio = (t: Tally): number => (t.total === 0 ? 1 : t.found / t.total);

/** A finding reduced to what the metrics read, severity-first. */
export interface ScoredFinding {
  /** The HEAD usage spans this finding covers (recorded usages matched to HEAD, misses already dropped). */
  spans: UsageSpan[];
  severity: 'info' | 'low' | 'medium' | 'high' | 'blocker';
  /** Every evidence location resolved and its snippet_hash matched (gate 1 passed). */
  evidence_valid: boolean;
  /** True when a finding proposes a change (not an out-of-scope mark). */
  proposes_change: boolean;
  files: string[];
  confidence: number;
}

export interface ScoreInput {
  /** True changed usages from truth.json, as HEAD spans. */
  truth: UsageSpan[];
  /** Files the real PR touched (for file precision). */
  truth_files: string[];
  /** Per-file source edit size, for severity calibration. */
  edit_size: Record<string, number>;
  findings: ScoredFinding[];
  /** out_of_scope entries, split by who wrote them (D16). */
  out_of_scope: { usage: UsageSpan; written_by: string }[];
  unresolved: number;
  /** Recorded findings dropped because HEAD no longer finds their usage (counted as misses, listed). */
  dropped_findings: number;
}

/** The non-trivial edit-size threshold for severity calibration (defined in code, plan task 5). */
export const CALIBRATION_MIN_EDIT = 3;

export interface Score {
  /** usage recall: true changed usages a finding covers. */
  recall: Tally;
  /** file precision: files a finding lists that the PR also touched. */
  file_precision: Tally;
  /** evidence validity: share of findings whose evidence all resolves (target 100%). */
  evidence_validity: Tally;
  /** severity calibration: high/blocker findings whose files needed non-trivial edits. */
  severity_calibration: Tally;
  /** false-alarm rate for high/blocker: high/blocker findings on files the PR didn't touch. */
  false_alarm_high: Tally;
  unresolved: number;
  out_of_scope_by_written_by: Record<string, number>;
  dropped_findings: number;
}

export function score(input: ScoreInput): Score {
  const truthFiles = new Set(input.truth_files);
  const covered = input.truth.filter((t) => input.findings.some((f) => f.spans.some((s) => sameSpan(s, t))));

  const changeFindings = input.findings.filter((f) => f.proposes_change);
  const evidenceValid = changeFindings.filter((f) => f.evidence_valid).length;

  const listedFiles = new Set(changeFindings.flatMap((f) => f.files));
  const filePrecisionHits = [...listedFiles].filter((f) => truthFiles.has(f)).length;

  const highBlocker = changeFindings.filter((f) => f.severity === 'high' || f.severity === 'blocker');
  const calibratedHits = highBlocker.filter((f) => f.files.some((file) => (input.edit_size[file] ?? 0) >= CALIBRATION_MIN_EDIT)).length;
  const falseAlarmHits = highBlocker.filter((f) => f.files.length > 0 && f.files.every((file) => !truthFiles.has(file))).length;

  const oosBy: Record<string, number> = {};
  for (const o of input.out_of_scope) oosBy[o.written_by] = (oosBy[o.written_by] ?? 0) + 1;

  return {
    recall: { found: covered.length, total: input.truth.length },
    file_precision: { found: filePrecisionHits, total: listedFiles.size },
    evidence_validity: { found: evidenceValid, total: changeFindings.length },
    severity_calibration: { found: calibratedHits, total: highBlocker.length },
    false_alarm_high: { found: falseAlarmHits, total: highBlocker.length },
    unresolved: input.unresolved,
    out_of_scope_by_written_by: oosBy,
    dropped_findings: input.dropped_findings,
  };
}

// -- Seeded precision (plan task 5, INV-31) ----------------------------------

export interface SeededEntry {
  id: string;
  expect: 'change' | 'no_change' | 'no_finding';
  /** The engine proposed a change on this entry. */
  proposed_change: boolean;
  /** The engine marked this entry out of scope. */
  marked_out_of_scope: boolean;
}

/** A finding on a no_change/no_finding entry is a false alarm; an out-of-scope mark on no_change is correct. */
export function seededPrecision(entries: readonly SeededEntry[]): { false_alarms: number; decoys: number } {
  let falseAlarms = 0;
  for (const e of entries) {
    if ((e.expect === 'no_change' || e.expect === 'no_finding') && e.proposed_change) falseAlarms += 1;
  }
  return { false_alarms: falseAlarms, decoys: entries.filter((e) => e.expect === 'no_finding').length };
}

// -- Pooled recall and the noise band (D17) ----------------------------------

/** One case's recall numbers for one run: covered true usages over all true usages. */
export interface CaseRunRecall {
  case_id: string;
  covered: number;
  total: number;
}
const caseRatio = (c: CaseRunRecall): number => (c.total === 0 ? 1 : c.covered / c.total);

/**
 * Pool recall over a set of cases: sum covered over sum total. Given each
 * case's chosen run (worst for the engine, best for the baseline).
 */
export function pooledRecall(perCase: readonly CaseRunRecall[]): Tally {
  return { found: perCase.reduce((n, c) => n + c.covered, 0), total: perCase.reduce((n, c) => n + c.total, 0) };
}

/** Across a case's runs, the one with the lowest recall (worst). Ties broken by case stability, not run index. */
export function worstRun(runs: readonly CaseRunRecall[]): CaseRunRecall {
  if (runs.length === 0) throw new Error('worstRun: no runs');
  return runs.reduce((lo, r) => (caseRatio(r) < caseRatio(lo) ? r : lo));
}
/** Across a case's runs, the one with the highest recall (best). */
export function bestRun(runs: readonly CaseRunRecall[]): CaseRunRecall {
  if (runs.length === 0) throw new Error('bestRun: no runs');
  return runs.reduce((hi, r) => (caseRatio(r) > caseRatio(hi) ? r : hi));
}

/**
 * A pack+side band: the engine's worst-case pooled recall and the baseline's
 * best-case pooled recall both come from here, with `pick` set to worstRun or
 * bestRun. `runsByCase` maps each case to all its runs on that side.
 */
export function bandFigure(runsByCase: ReadonlyMap<string, readonly CaseRunRecall[]>, pick: (r: readonly CaseRunRecall[]) => CaseRunRecall): {
  pooled: Tally;
  perCase: CaseRunRecall[];
} {
  const perCase = [...runsByCase.keys()].sort().map((id) => pick(runsByCase.get(id)!));
  return { pooled: pooledRecall(perCase), perCase };
}
