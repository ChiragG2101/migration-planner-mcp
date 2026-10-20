// The CI pack gate (M7 task 7, D17, INV-43). Pure checks over the scored runs
// of each pack at HEAD, plus the base branch's recorded band. The runner does
// the replay and I/O; this module decides pass/fail so a fixture test can feed
// it hand-made numbers. Verdicts that depend on the base branch live only in
// the gate output, never in results.md (D17).
import { bandFigure, pooledRecall, ratio, worstRun, bestRun, type CaseRunRecall, type Tally } from './metrics.js';

const EPS = 1e-9;

export interface Host {
  product: string;
  model: string;
}

/** One pack's recorded runs at HEAD, already scored for recall. */
export interface PackRuns {
  pack: string;
  /** case id -> engine runs (each a case/run recall), under HEAD's current prompt version. */
  engine: Map<string, CaseRunRecall[]>;
  /** case id -> baseline runs. */
  baseline: Map<string, CaseRunRecall[]>;
  /** Hosts of every engine and baseline run of the pack (product+model must be uniform). */
  hosts: Host[];
  /** True changed usages across the pack's cases (for the "no true usage" check). */
  trueUsages: number;
  /** Committed golden cases of the pack at HEAD (independent of whether runs exist). */
  goldenCases: number;
  /** True when a pinned case commit could not be fetched and was not cached. */
  commit_unavailable: string[];
}

/** The band a pack had on the base branch, keyed by case so it can be recomputed over shared cases (D17). */
export interface BaseBand {
  /** case id -> engine worst-run recall on the base branch. */
  engineWorst: Map<string, CaseRunRecall>;
}

export interface PackGateInput {
  runs: PackRuns;
  /** The base branch's band for this pack, or null when it had none (then the beat check applies, regression is skipped). */
  base: BaseBand | null;
  /** True when this PR adds golden cases to the pack (widening). */
  widening: boolean;
  /** The one pack exempt from the beat check: it sets the first band (nextjs-upgrade). */
  exemptFromBeat: boolean;
}

export interface GateVerdict {
  pack: string;
  /** Hard failures that fail the PR. */
  failures: string[];
  /** Lines for the CI job output (base-dependent verdicts; never results.md). */
  notes: string[];
  engineWorstPooled: Tally;
  baselineBestPooled: Tally;
}

function hostsUniform(hosts: readonly Host[]): boolean {
  if (hosts.length === 0) return true;
  const first = hosts[0]!;
  return hosts.every((h) => h.product === first.product && h.model === first.model);
}

/** Pool a map's chosen runs over only the cases in `only`. */
function pooledOver(map: ReadonlyMap<string, readonly CaseRunRecall[]>, pick: (r: readonly CaseRunRecall[]) => CaseRunRecall, only: Iterable<string>): Tally {
  const perCase: CaseRunRecall[] = [];
  for (const id of only) {
    const runs = map.get(id);
    if (runs && runs.length > 0) perCase.push(pick(runs));
  }
  return pooledRecall(perCase);
}

export function packGate(input: PackGateInput): GateVerdict {
  const { runs } = input;
  const failures: string[] = [];
  const notes: string[] = [];

  // Fail closed on an unfetchable, uncached case commit (never skip the case).
  for (const id of runs.commit_unavailable) failures.push(`case_commit_unavailable: ${id}`);

  const caseIds = [...new Set([...runs.engine.keys(), ...runs.baseline.keys()])].sort();

  // A pack at HEAD with zero golden cases fails outright (D17).
  if (runs.goldenCases === 0) {
    failures.push(`pack ${runs.pack} has zero golden cases at HEAD`);
    return { pack: runs.pack, failures, notes, engineWorstPooled: { found: 0, total: 0 }, baselineBestPooled: { found: 0, total: 0 } };
  }

  // A pack that has golden cases but no recorded runs yet is not scorable: report
  // and skip. The beat/counts checks only bite once runs are recorded (M7 defers
  // the golden runs to a live session; CI stays green meanwhile).
  if (caseIds.length === 0) {
    notes.push(`pack ${runs.pack}: ${runs.goldenCases} golden case(s), no recorded runs yet; not scored.`);
    return { pack: runs.pack, failures, notes, engineWorstPooled: { found: 0, total: 0 }, baselineBestPooled: { found: 0, total: 0 } };
  }

  // Counts.
  if (runs.goldenCases < 2) failures.push(`pack ${runs.pack} has fewer than 2 golden cases (${runs.goldenCases})`);
  if (runs.trueUsages === 0) failures.push(`pack ${runs.pack} has no true changed usage across its cases`);
  const counts = new Set<number>();
  for (const id of caseIds) {
    const e = runs.engine.get(id)?.length ?? 0;
    const b = runs.baseline.get(id)?.length ?? 0;
    if (e < 3) failures.push(`case ${id}: ${e} engine runs (need >= 3)`);
    if (b < 3) failures.push(`case ${id}: ${b} baseline runs (need >= 3)`);
    if (e !== b) failures.push(`case ${id}: engine runs (${e}) != baseline runs (${b})`);
    counts.add(e);
    counts.add(b);
  }
  if (counts.size > 1) failures.push(`pack ${runs.pack}: run counts differ across cases/sides (${[...counts].sort().join(', ')})`);
  if (!hostsUniform(runs.hosts)) failures.push(`pack ${runs.pack}: runs do not all share one host product and model`);

  // Figures: engine worst-case pooled recall, baseline best-case pooled recall.
  const engineFig = bandFigure(runs.engine, worstRun);
  const baselineFig = bandFigure(runs.baseline, bestRun);
  const engineWorstPooled = engineFig.pooled;
  const baselineBestPooled = baselineFig.pooled;

  // Beat check: applies to a pack with no base band (whichever PR adds cases),
  // and again over all cases when a beat-checked pack is widened. nextjs-upgrade
  // is exempt in M7 (it sets the first band); its result is shown, not enforced.
  const beats = ratio(engineWorstPooled) > ratio(baselineBestPooled) + EPS;
  if (!input.base) {
    if (input.exemptFromBeat) {
      notes.push(`pack ${runs.pack}: no base band; beat check not enforced (sets the first band). engine ${ratio(engineWorstPooled).toFixed(4)} vs baseline ${ratio(baselineBestPooled).toFixed(4)}.`);
    } else if (!beats) {
      failures.push(`pack ${runs.pack}: engine worst-case pooled recall ${ratio(engineWorstPooled).toFixed(4)} does not beat baseline best-case ${ratio(baselineBestPooled).toFixed(4)}`);
    } else {
      notes.push(`pack ${runs.pack}: beats the baseline (engine ${ratio(engineWorstPooled).toFixed(4)} > baseline ${ratio(baselineBestPooled).toFixed(4)}).`);
    }
  } else if (input.widening) {
    const verdict = `pack ${runs.pack}: widened; all-case beat engine ${ratio(engineWorstPooled).toFixed(4)} vs baseline ${ratio(baselineBestPooled).toFixed(4)}`;
    if (input.exemptFromBeat) notes.push(`${verdict} (shown, not enforced).`);
    else if (!beats) failures.push(`${verdict}: does not beat the baseline over all cases`);
    else notes.push(`${verdict}: beats the baseline.`);
  }

  // Regression check: over the base band's cases present at HEAD, engine worst
  // must not fall below the base band low end recomputed over the same cases.
  // Skipped (with a note) when the base branch had no band (D17).
  if (!input.base) {
    notes.push(`pack ${runs.pack}: no base band; regression check skipped.`);
  } else {
    const shared = [...input.base.engineWorst.keys()].filter((id) => runs.engine.has(id));
    const baseLow = pooledRecall(shared.map((id) => input.base!.engineWorst.get(id)!));
    const headOverShared = pooledOver(runs.engine, worstRun, shared);
    if (ratio(headOverShared) + EPS < ratio(baseLow)) {
      failures.push(`pack ${runs.pack}: engine worst-case pooled recall ${ratio(headOverShared).toFixed(4)} over base cases fell below the base band low end ${ratio(baseLow).toFixed(4)}`);
    } else {
      notes.push(`pack ${runs.pack}: no regression (engine ${ratio(headOverShared).toFixed(4)} >= base low ${ratio(baseLow).toFixed(4)} over ${shared.length} shared cases).`);
    }
  }

  return { pack: runs.pack, failures, notes, engineWorstPooled, baselineBestPooled };
}
