import type { GetRulePackOutput } from '../schema/rulePack.js';

export function formatPackText(out: GetRulePackOutput): string {
  const lines = [`pack ${out.pack}`, `supported ${out.supported.from} to ${out.supported.to}`, `${out.rules.length} composed rules`];
  for (const r of out.rules) lines.push(`  ${r.id} ${r.necessity} lands_on ${r.lands_on}${r.codemod ? ` codemod ${r.codemod}` : ''}`);
  for (const c of out.codemods) lines.push(`codemod ${c.id}: ${c.rules.length ? c.rules.join(', ') : 'no rule names it'}`);
  for (const n of out.notes) lines.push(`note: ${n}`);
  for (const r of out.references) lines.push(`reference ${r}`);
  return lines.join('\n');
}
