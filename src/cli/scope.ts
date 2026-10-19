import type { ProposeScopeOutput, SetScopeOutput } from '../schema/scope.js';

export function formatProposalText(out: ProposeScopeOutput): string {
  const lines = [`run ${out.run_id}`, `size ${out.size}`, `level ${out.info.level}, checks declared: ${out.info.checks_declared}`];
  for (const r of out.reasons) lines.push(`  ${r}`);
  for (const h of out.hidden_behavior) lines.push(`hidden: ${h.id} — ${h.title}`);
  for (const q of out.questions) {
    const def = Array.isArray(q.default) ? q.default.join(',') : q.default;
    lines.push(`question ${q.id}: ${q.prompt} (default ${def})`);
    for (const o of q.options) lines.push(`  - ${o.id}`);
  }
  return lines.join('\n');
}

export function formatScopeText(out: SetScopeOutput): string {
  const lines = [`run ${out.run_id}`, `size ${out.size}`];
  if (out.defaults.length) lines.push(`defaults: ${out.defaults.join(', ')}`);
  for (const [k, v] of Object.entries(out.answers)) lines.push(`answer ${k}=${Array.isArray(v) ? v.join(',') : v}`);
  for (const e of out.out_of_scope) lines.push(`out of scope ${e.usage_id}: ${e.reason}`);
  return lines.join('\n');
}
