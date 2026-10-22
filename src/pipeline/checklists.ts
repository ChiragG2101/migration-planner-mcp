// Per-stage checklists (M9 task 3). Part of the normal L0 emit: emit_plan
// writes one <out>/<run_id>/stages/<n>/CHECKLIST.md per stage through
// safeWrite. Codemods come first, then each manual finding's action, verify
// and rollback, then the pack's checks hint. Deterministic text only.
import type { Finding } from '../schema/finding.js';
import type { Stage } from '../schema/plan.js';

/** Where a stage's checklist goes, relative to the output folder. `n` is the stage's 1-based position. */
export function checklistPath(runId: string, stage: Stage): string {
  return `${runId}/stages/${stage.order + 1}/CHECKLIST.md`;
}

/** Marks shown after a finding that routing lifted out of the main plan. */
export type RoutedMark = 'review first' | 'needs human decision';

export function renderChecklist(stage: Stage, findings: readonly Finding[], checksHint: string, routed: ReadonlyMap<string, RoutedMark> = new Map()): string {
  const inStage = stage.finding_ids.map((id) => findings.find((f) => f.id === id)).filter((f): f is Finding => f !== undefined);
  const mark = (f: Finding): string => {
    const tags = [routed.get(f.id), f.docs_status === 'unverified' ? 'docs unverified' : undefined].filter(Boolean);
    return tags.length ? ` _(${tags.join(', ')})_` : '';
  };
  const where = (f: Finding): string => (f.evidence.length ? ` — ${f.evidence.map((e) => `\`${e.file}:${e.line_start}\``).join(', ')}` : '');
  const out: string[] = [`# Stage ${stage.order + 1}: ${stage.title}`, ''];
  if (stage.depends_on.length) out.push(`Do this after: ${stage.depends_on.join(', ')}.`, '');

  const codemods = inStage.filter((f) => f.step_kind === 'codemod' && f.codemod);
  const manual = inStage.filter((f) => !(f.step_kind === 'codemod' && f.codemod));
  out.push('## Codemods', '');
  if (!codemods.length) out.push('_None in this stage._');
  for (const f of codemods) out.push(`- [ ] Run \`${f.codemod}\` (${f.id})${where(f)}${mark(f)}`);
  out.push('');

  out.push('## Manual steps', '');
  if (!manual.length) out.push('_None in this stage._', '');
  for (const f of manual) {
    out.push(`- [ ] **${f.id}** (${f.severity})${where(f)}${mark(f)}`);
    out.push(`  - Action: ${f.action}`);
    out.push(`  - Verify: ${f.verify}`);
    if (f.rollback) out.push(`  - Rollback: ${f.rollback}`);
    out.push('');
  }

  out.push('## Checks', '', `- [ ] ${checksHint}`, '');
  return out.join('\n');
}
