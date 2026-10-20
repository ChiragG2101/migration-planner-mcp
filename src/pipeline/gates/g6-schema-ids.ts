// Gate 6 (INV-20): Zod validates the whole plan, and finding and stage IDs are
// unique. It also checks that every stage's finding_ids name a real finding and
// that every finding is placed in exactly one stage, so a malformed plan can't
// slip a finding past the other gates by leaving it unstaged.
import { Plan, type GateResult } from '../../schema/plan.js';
import { fieldErrors } from '../../schema/finding.js';
import type { Gate } from './index.js';

export const g6SchemaIds: Gate = {
  id: 'g6_schema_ids',
  run(plan: Plan): GateResult[] {
    const results: GateResult[] = [];
    const parsed = Plan.safeParse(plan);
    if (!parsed.success) {
      for (const e of fieldErrors(parsed.error)) {
        results.push({ gate: 'g6_schema_ids', subject: null, pass: false, reason: `schema: ${e.path || '(root)'} ${e.message}` });
      }
      return results;
    }

    const dupFinding = duplicates(plan.findings.map((f) => f.id));
    for (const id of dupFinding) results.push({ gate: 'g6_schema_ids', subject: id, pass: false, reason: `finding id ${id} is used more than once` });

    const dupStage = duplicates(plan.stages.map((s) => s.id));
    for (const id of dupStage) results.push({ gate: 'g6_schema_ids', subject: id, pass: false, reason: `stage id ${id} is used more than once` });

    const findingIds = new Set(plan.findings.map((f) => f.id));
    const placed = new Map<string, number>();
    for (const stage of plan.stages) {
      for (const id of stage.finding_ids) {
        if (!findingIds.has(id)) results.push({ gate: 'g6_schema_ids', subject: stage.id, pass: false, reason: `stage ${stage.id} lists finding ${id}, which is not in the plan` });
        placed.set(id, (placed.get(id) ?? 0) + 1);
      }
    }
    for (const [id, n] of placed) if (n > 1) results.push({ gate: 'g6_schema_ids', subject: id, pass: false, reason: `finding ${id} is placed in ${n} stages` });
    for (const f of plan.findings) if (!placed.has(f.id)) results.push({ gate: 'g6_schema_ids', subject: f.id, pass: false, reason: `finding ${f.id} is in no stage` });

    if (results.length === 0) results.push({ gate: 'g6_schema_ids', subject: null, pass: true, reason: 'the plan is schema-valid and every finding and stage id is unique and placed' });
    return results;
  },
};

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}
