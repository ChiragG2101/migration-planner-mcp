// validate_plan (M6 task 3). Runs the six gates on the stored plan, records the
// round's results as gate.result events, and keeps unresolved items visible.
// Round cap = 3: after the third round, failing findings and stages move to
// plan.unresolved[] with their gate reasons and the plan is still stored and
// emitted, but it is never marked passed (INV-15 to INV-20).
import { z } from 'zod';
import { landsOnOf, BUMP_STAGE_ID } from '../pipeline/aggregate.js';
import { runGates, type GateContext } from '../pipeline/gates/index.js';
import type { ComposedRule } from '../rules/compose.js';
import type { GateResult, Plan, PlanStatus, Unresolved } from '../schema/plan.js';
import { ValidatePlanInput, type ValidatePlanOutput } from '../schema/plan.js';
import { InputError } from '../security/errors.js';
import { repoRoot } from '../store/campaigns.js';
import { listRunDocs } from '../store/docs.js';
import { getPlan, latestRound, putPlan, putPlanRound } from '../store/plans.js';
import { getScope } from '../store/scope.js';
import { runTool, type Engine } from './engine.js';
import { composeRun, openRunPack, requireUsages } from './packRun.js';

export const MAX_ROUNDS = 3;

/** Failing results become unresolved entries, newest reason per subject. */
function toUnresolved(results: readonly GateResult[], plan: Plan): Unresolved[] {
  const byFinding = new Set(plan.findings.map((f) => f.id));
  const out: Unresolved[] = [];
  for (const r of results) {
    if (r.pass) continue;
    out.push({ finding_id: r.subject !== null && byFinding.has(r.subject) ? r.subject : null, gate: r.gate, reason: r.reason });
  }
  return out;
}

export async function validatePlan(engine: Engine, raw: unknown): Promise<ValidatePlanOutput> {
  const parsed = ValidatePlanInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'validate_plan', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const stored = getPlan(db, opened.run.id);
    if (!stored) throw new InputError('no_plan', `run ${opened.run.id} has no plan; call merge_findings first`);
    const prev = latestRound(db, opened.run.id);
    const round = (prev?.round ?? 0) + 1;

    const loaded = requireUsages(opened.session, opened.run.id);
    const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
    if (!root) throw new InputError('unknown_run', `run ${opened.run.id} has no repo`);
    const scope = getScope(db, opened.run.id);
    const stop = scope?.answers['stop_at'];
    const composed = composeRun(opened.pack, opened.versions, {
      ...(typeof stop === 'string' ? { stopAt: stop } : {}),
      usages: loaded.usages,
    });
    const rules: ComposedRule[] = composed.libraries.flatMap((l) => l.rules);
    const usagesById = new Map(loaded.usages.map((u) => [u.id, u]));
    const landsOn = new Map<string, 'source' | 'target'>();
    for (const f of stored.plan.findings) landsOn.set(f.id, landsOnOf(f, usagesById, rules));
    landsOn.set('engine-bump', 'source');
    const bumpStageId = stored.plan.stages.some((s) => s.id === BUMP_STAGE_ID) ? BUMP_STAGE_ID : null;

    const ctx: GateContext = {
      repoRoot: root,
      repoId: opened.run.repo_id,
      usages: loaded.usages,
      imports: loaded.imports,
      docs: listRunDocs(db, opened.run.id),
      landsOn,
      bumpStageId,
    };

    const before = stored.plan;
    const results = runGates(before, ctx);
    const failed = results.filter((r) => !r.pass);
    const capped = round >= MAX_ROUNDS && failed.length > 0;
    const passed = failed.length === 0;

    // After the cap (or when passing) the plan carries the unresolved items; a
    // passing plan has none. Before the cap, failures are reported but the plan
    // is left for the agent to fix in the next round.
    const unresolved = passed ? [] : capped ? toUnresolved(failed, before) : [];
    const after: Plan = { ...before, unresolved };
    const status: PlanStatus = passed ? 'passed' : capped ? 'capped' : 'failed';

    putPlan(db, opened.run.id, after, round, status);
    putPlanRound(db, opened.run.id, round, status, results);
    call.event('gate.result', { round, status, before: before.unresolved, after: unresolved, results });
    call.event('validate.result', { round, status, passed, capped, failed: failed.length });

    return { run_id: opened.run.id, round, status, passed, capped, results, unresolved };
  });
}