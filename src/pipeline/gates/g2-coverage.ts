// Gate 2 (INV-16): every find_usages usage for the run is covered by a
// finding's usage_ids, or by an out_of_scope entry with a non-empty reason. A
// scope-excluded usage counts as covered by its `scope` entry, never by a
// finding; the aggregator (task 1) removes it from any finding's coverage, and
// a finding kept out of the plan because it was left covering no usage covers
// nothing (docs/design.md D16).
import type { GateResult, Plan } from '../../schema/plan.js';
import type { Gate, GateContext } from './index.js';

export const g2Coverage: Gate = {
  id: 'g2_coverage',
  run(plan: Plan, ctx: GateContext): GateResult[] {
    const covered = new Set<string>();
    for (const finding of plan.findings) for (const id of finding.usage_ids) covered.add(id);
    const scoped = new Set<string>();
    for (const o of plan.out_of_scope) if (o.reason.trim() !== '') scoped.add(o.usage_id);
    const results: GateResult[] = [];
    // An out_of_scope entry with an empty reason does not cover (its usage then
    // reads as uncovered below), and is reported so the gate names the hole.
    for (const [i, o] of plan.out_of_scope.entries()) {
      if (o.reason.trim() === '') {
        results.push({ gate: 'g2_coverage', subject: o.usage_id, pass: false, reason: `out_of_scope[${i}] for ${o.usage_id} has an empty reason` });
      }
    }
    for (const usage of ctx.usages) {
      if (covered.has(usage.id)) {
        results.push({ gate: 'g2_coverage', subject: usage.id, pass: true, reason: `${usage.id} is covered by a finding` });
      } else if (scoped.has(usage.id)) {
        results.push({ gate: 'g2_coverage', subject: usage.id, pass: true, reason: `${usage.id} is marked out of scope with a reason` });
      } else {
        results.push({ gate: 'g2_coverage', subject: usage.id, pass: false, reason: `usage ${usage.id} (${usage.file}:${usage.line_start} ${usage.kind}) is neither covered by a finding nor marked out of scope` });
      }
    }
    return results;
  },
};
