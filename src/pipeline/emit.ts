// The MIGRATION_PLAN.md formatter (M6 task 4). Deterministic text only: a
// stage-by-stage summary, each finding with severity, file:line, docs links,
// action, rollback and verify, an Unresolved section at the top when non-empty,
// and a footer naming the pack version, the prompt version and that the target
// repo was not modified. No file writes happen here; emit_plan writes through
// safeWrite.
import type { Finding } from '../schema/finding.js';
import type { Severity } from '../schema/knowledge.js';
import type { Plan, PlanStatus } from '../schema/plan.js';

function findingBlock(f: Finding): string {
  const lines: string[] = [];
  lines.push(`#### ${f.id} — ${f.severity.toUpperCase()} (${f.concern})`);
  for (const e of f.evidence) lines.push(`- \`${e.file}:${e.line_start}-${e.line_end}\``);
  for (const d of f.doc_refs) lines.push(`- docs: [${d.library}@${d.version}](${d.url})`);
  lines.push('');
  lines.push(`**Action.** ${f.action}`);
  if (f.step_kind === 'codemod' && f.codemod) lines.push(`**Codemod.** \`${f.codemod}\``);
  if (f.rollback) lines.push(`**Rollback.** ${f.rollback}`);
  lines.push(`**Verify.** ${f.verify}`);
  if (f.docs_status === 'unverified') lines.push(`_docs unverified_`);
  return lines.join('\n');
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Renders the whole plan as Markdown. */
export function renderPlanMarkdown(plan: Plan, meta: { packVersion: string; status: PlanStatus }): string {
  const byId = new Map(plan.findings.map((f) => [f.id, f]));
  const out: string[] = [];
  out.push(`# Migration plan`);
  out.push('');
  out.push(`- Pack: \`${plan.pack}\``);
  out.push(`- Prompt: \`${plan.prompt_version}\``);
  out.push(`- Status: **${meta.status}**`);
  out.push('');

  if (plan.unresolved.length) {
    out.push(`## Unresolved (${plan.unresolved.length})`);
    out.push('');
    out.push('These failed a gate after the round cap and were not resolved. Review them before applying the plan.');
    out.push('');
    for (const u of plan.unresolved) {
      out.push(`- **${u.gate ?? 'gate'}**${u.finding_id ? ` (${u.finding_id})` : ''}: ${u.reason}`);
    }
    out.push('');
  }

  out.push(`## Stages`);
  out.push('');
  for (const stage of [...plan.stages].sort((a, b) => a.order - b.order)) {
    out.push(`### ${stage.order + 1}. ${stage.title}`);
    if (stage.depends_on.length) out.push(`_depends on: ${stage.depends_on.join(', ')}_`);
    out.push('');
    const findings = stage.finding_ids
      .map((id) => byId.get(id))
      .filter((f): f is Finding => f !== undefined)
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    if (!findings.length) out.push('_No findings in this stage._');
    for (const f of findings) {
      out.push(findingBlock(f));
      out.push('');
    }
  }

  if (plan.out_of_scope.length) {
    out.push(`## Out of scope (${plan.out_of_scope.length})`);
    out.push('');
    for (const o of plan.out_of_scope) out.push(`- \`${o.usage_id}\` — ${o.reason} _(by ${o.written_by})_`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`Pack \`${plan.pack}\` version ${meta.packVersion}, prompt ${plan.prompt_version}. The target repo was not modified by this plan.`);
  return out.join('\n') + '\n';
}
