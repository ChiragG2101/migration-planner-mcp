import type { EmitPlanOutput, MergeFindingsOutput, ValidatePlanOutput } from '../schema/plan.js';

export function formatMergeText(out: MergeFindingsOutput): string {
  const lines = [`run ${out.run_id}`, `round ${out.round}`, `size ${out.size}`, `stages ${out.plan.stages.length}`, `findings ${out.plan.findings.length}`];
  for (const s of [...out.plan.stages].sort((a, b) => a.order - b.order)) lines.push(`  stage ${s.order + 1}: ${s.title} (${s.finding_ids.length} findings)`);
  if (out.uncovered_usages.length) lines.push(`uncovered usages: ${out.uncovered_usages.length}`);
  for (const c of out.conflicts) lines.push(`conflict (${c.kind}): ${c.detail}`);
  for (const id of out.dropped_findings) lines.push(`dropped finding: ${id}`);
  return lines.join('\n');
}

export function formatValidateText(out: ValidatePlanOutput): string {
  const lines = [`run ${out.run_id}`, `round ${out.round}`, `status ${out.status}`];
  const failed = out.results.filter((r) => !r.pass);
  lines.push(`gates: ${out.results.length - failed.length} pass, ${failed.length} fail`);
  for (const r of failed) lines.push(`  FAIL ${r.gate}${r.subject ? ` [${r.subject}]` : ''}: ${r.reason}`);
  for (const u of out.unresolved) lines.push(`  unresolved ${u.gate ?? ''}${u.finding_id ? ` (${u.finding_id})` : ''}: ${u.reason}`);
  return lines.join('\n');
}

export function formatEmitText(out: EmitPlanOutput): string {
  return [`run ${out.run_id}`, `round ${out.round}`, `status ${out.status}`, `wrote ${out.plan_json}`, `wrote ${out.plan_md}`, `unresolved ${out.unresolved}`].join('\n');
}
