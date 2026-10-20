// The six deterministic gates (M6, PRD section 7). Each is one module sharing
// the Gate interface, re-checks against real files, and imports no network or
// model code (the ESLint override on src/pipeline/gates/** and
// test/permissions/gates-no-model.test.ts enforce that). The interface is
// shared with gate 7 (src/verify/testIntegrity.ts, M8), so every gate reports
// in one GateResult shape. After 3 rounds, failures go to unresolved[] and are
// never marked passed (validate_plan).
import type { GateResult, Plan } from '../../schema/plan.js';
import type { Usage } from '../../schema/usage.js';
import type { RunDocRow } from '../../store/docs.js';
import type { ImportRow } from '../../store/usages.js';
import { g1Evidence } from './g1-evidence.js';
import { g2Coverage } from './g2-coverage.js';
import { g3DocRefs } from './g3-doc-refs.js';
import { g4RollbackVerify } from './g4-rollback-verify.js';
import { g5StageOrder } from './g5-stage-order.js';
import { g6SchemaIds } from './g6-schema-ids.js';

export interface GateContext {
  /** The run's repo root, for resolving evidence through SafePath (gate 1). */
  repoRoot: string;
  repoId: string;
  /** Every usage find_usages produced for the run (gate 2's universe). */
  usages: readonly Usage[];
  /** The import graph (gate 5). */
  imports: readonly ImportRow[];
  /** The docs registered in this run (gate 3). */
  docs: readonly RunDocRow[];
  /**
   * Facts the engine derives deterministically and hands to gate 5: where each
   * finding lands (`source` prep or `target`), and the id of the dependency and
   * build stage. A finding with no entry is treated as `target`, the safe
   * default (docs/design.md D5). The gate itself computes no rule facts.
   */
  landsOn: ReadonlyMap<string, 'source' | 'target'>;
  bumpStageId: string | null;
}

export interface Gate {
  readonly id: GateResult['gate'];
  run(plan: Plan, ctx: GateContext): GateResult[];
}

export const GATES: readonly Gate[] = [g1Evidence, g2Coverage, g3DocRefs, g4RollbackVerify, g5StageOrder, g6SchemaIds];

/** Runs every gate and returns all results, in gate order. */
export function runGates(plan: Plan, ctx: GateContext): GateResult[] {
  return GATES.flatMap((gate) => gate.run(plan, ctx));
}
