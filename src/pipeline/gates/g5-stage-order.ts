// Gate 5 (INV-19, INV-29): stage order is valid.
//  - depends_on forms a DAG (no cycle) and every id exists.
//  - A stage runs after every stage it depends on (order respects depends_on).
//  - For each stage S and each finding in S touching file F, no file F imports
//    (transitively, via the import graph) has a required change in a LATER
//    stage. A "required change" on a file is a finding whose evidence touches
//    it.
//  - The dependency and build (bump) stage: no prep (`lands_on: source`) stage
//    depends on it, and no `lands_on: target` finding is staged before it.
// Findings whose file has an unresolved dynamic import get a
// `stage_order_unverified` warning rather than a silent pass (risk mitigation).
import type { GateResult, Plan, Stage } from '../../schema/plan.js';
import type { Gate, GateContext } from './index.js';

/** file -> files it imports directly (resolved edges only). */
function directImports(imports: GateContext['imports']): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of imports) {
    if (!e.to_file) continue;
    const set = out.get(e.from_file) ?? new Set<string>();
    set.add(e.to_file);
    out.set(e.from_file, set);
  }
  return out;
}

/** Files reachable from `start` by following imports transitively (excluding start). */
function reachable(start: string, direct: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(direct.get(start) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const f of direct.get(next) ?? []) if (!seen.has(f)) stack.push(f);
  }
  return seen;
}

/** True when any edge out of `file` is an unresolved dynamic import (to_file null). */
function hasUnresolved(imports: GateContext['imports']): Set<string> {
  const out = new Set<string>();
  for (const e of imports) if (!e.to_file) out.add(e.from_file);
  return out;
}

export const g5StageOrder: Gate = {
  id: 'g5_stage_order',
  run(plan: Plan, ctx: GateContext): GateResult[] {
    const results: GateResult[] = [];
    const byId = new Map(plan.stages.map((s) => [s.id, s]));
    const orderOf = new Map(plan.stages.map((s) => [s.id, s.order]));

    // depends_on references and acyclicity.
    for (const stage of plan.stages) {
      for (const dep of stage.depends_on) {
        if (!byId.has(dep)) {
          results.push({ gate: 'g5_stage_order', subject: stage.id, pass: false, reason: `${stage.id} depends_on ${dep}, which is not a stage` });
        } else if ((orderOf.get(dep) ?? 0) >= stage.order) {
          results.push({ gate: 'g5_stage_order', subject: stage.id, pass: false, reason: `${stage.id} (order ${stage.order}) depends on ${dep} (order ${orderOf.get(dep)}), which does not run earlier` });
        }
      }
    }
    const cyclic = cycle(plan.stages);
    if (cyclic) results.push({ gate: 'g5_stage_order', subject: null, pass: false, reason: `depends_on has a cycle: ${cyclic.join(' -> ')}` });

    // Stage index of each file that a finding touches, and each file's earliest change stage.
    const stageOfFinding = new Map<string, Stage>();
    for (const stage of plan.stages) for (const id of stage.finding_ids) stageOfFinding.set(id, stage);
    const changeStage = new Map<string, number>(); // file -> earliest stage order with a required change
    for (const finding of plan.findings) {
      const stage = stageOfFinding.get(finding.id);
      if (!stage) continue;
      for (const e of finding.evidence) {
        const prev = changeStage.get(e.file);
        if (prev === undefined || stage.order < prev) changeStage.set(e.file, stage.order);
      }
    }

    const direct = directImports(ctx.imports);
    const unresolved = hasUnresolved(ctx.imports);
    for (const finding of plan.findings) {
      const stage = stageOfFinding.get(finding.id);
      if (!stage) continue;
      let flaggedUnverified = false;
      for (const e of finding.evidence) {
        if (unresolved.has(e.file) && !flaggedUnverified) {
          results.push({ gate: 'g5_stage_order', subject: finding.id, pass: true, reason: `stage_order_unverified: ${e.file} has an unresolved dynamic import, so its transitive order is not fully checked` });
          flaggedUnverified = true;
        }
        for (const imported of reachable(e.file, direct)) {
          const laterOrder = changeStage.get(imported);
          if (laterOrder !== undefined && laterOrder > stage.order) {
            results.push({ gate: 'g5_stage_order', subject: finding.id, pass: false, reason: `${finding.id} in ${stage.id} (order ${stage.order}) touches ${e.file}, which imports ${imported}; that dependency is changed later in a stage at order ${laterOrder}`, expected: `<= ${stage.order}`, actual: String(laterOrder) });
          }
        }
      }
    }

    // The bump stage: no prep stage depends on it, no target finding before it.
    const bumpStage = ctx.bumpStageId ? byId.get(ctx.bumpStageId) : undefined;
    if (bumpStage) {
      const bumpOrder = bumpStage.order;
      for (const stage of plan.stages) {
        if (stage.order >= bumpOrder) continue;
        if (dependsOnTransitively(stage.id, ctx.bumpStageId!, byId)) {
          results.push({ gate: 'g5_stage_order', subject: stage.id, pass: false, reason: `prep stage ${stage.id} (order ${stage.order}) depends on the bump stage ${ctx.bumpStageId}` });
        }
      }
      for (const finding of plan.findings) {
        const stage = stageOfFinding.get(finding.id);
        if (!stage || stage.order >= bumpOrder) continue;
        // A `lands_on: target` finding (the default when unknown) must be in the
        // bump stage or later, never in a prep stage before it (D5, INV-29).
        const lands = ctx.landsOn.get(finding.id) ?? 'target';
        if (lands === 'target') {
          results.push({ gate: 'g5_stage_order', subject: finding.id, pass: false, reason: `${finding.id} lands on target but is staged at order ${stage.order}, before the bump stage ${ctx.bumpStageId} (order ${bumpOrder})`, expected: `>= ${bumpOrder}`, actual: String(stage.order) });
        }
      }
    }

    if (results.every((r) => r.pass)) results.push({ gate: 'g5_stage_order', subject: null, pass: true, reason: 'stage order respects the import graph, depends_on is acyclic, and the bump stage is ordered correctly' });
    return results;
  },
};

/** The first depends_on cycle among the stages, or null. */
function cycle(stages: readonly Stage[]): string[] | null {
  const deps = new Map(stages.map((s) => [s.id, s.depends_on.filter((d) => stages.some((x) => x.id === d))]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const walk = (id: string): string[] | null => {
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (state.get(dep) === 'visiting') return [...path.slice(path.indexOf(dep)), dep];
      if (!state.has(dep)) {
        const found = walk(dep);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const s of stages) if (!state.has(s.id)) {
    const found = walk(s.id);
    if (found) return found;
  }
  return null;
}

function dependsOnTransitively(from: string, target: string, byId: Map<string, Stage>): boolean {
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.depends_on ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const d of byId.get(next)?.depends_on ?? []) stack.push(d);
  }
  return false;
}
