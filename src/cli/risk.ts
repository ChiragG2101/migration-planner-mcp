import type { AssessRiskOutput } from '../schema/risk.js';

export function formatRiskText(out: AssessRiskOutput): string {
  const lines = [`run ${out.run_id}: ${out.risks.length} usages`];
  for (const r of out.risks) {
    lines.push(`${r.suggested_severity}\t${r.file}:${r.line}\t${r.kind}\t${r.symbol}${r.unmapped ? '\tunmapped' : ''}`);
    for (const s of r.signals) lines.push(`  ${s.name}: ${s.detail}`);
  }
  return lines.join('\n');
}
