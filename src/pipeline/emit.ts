// The MIGRATION_PLAN.md formatter (M6 task 4, reordered by M9 task 2).
// Deterministic, templated text only, so it is not padded. Order:
//   1. Review first   2. Unresolved   3. Needs human decision (only when non-empty)
//   4. per-stage summary (one or two lines each, with the L1 decision)
//   5. stage details  6. footer (pack, prompt and gate versions, the threshold,
//   and the repo-untouched line).
// "Docs unverified" findings carry the badge wherever they land. No file
// writes happen here; emit_plan writes through safeWrite.
import type { Finding } from '../schema/finding.js';
import type { Severity } from '../schema/knowledge.js';
import type { Plan, PlanStatus } from '../schema/plan.js';
import type { Routing, StageVerify } from './routing.js';

const BADGE = '_docs unverified_';

function findingBlock(f: Finding, note?: string): string {
  const lines: string[] = [];
  lines.push(`#### ${f.id} — ${f.severity.toUpperCase()} (${f.concern})${f.docs_status === 'unverified' ? ` ${BADGE}` : ''}`);
  if (note) lines.push(`_${note}_`);
  for (const e of f.evidence) lines.push(`- \`${e.file}:${e.line_start}-${e.line_end}\``);
  for (const d of f.doc_refs) lines.push(`- docs: [${d.library}@${d.version}](${d.url})`);
  lines.push('');
  lines.push(`**Action.** ${f.action}`);
  if (f.step_kind === 'codemod' && f.codemod) lines.push(`**Codemod.** \`${f.codemod}\``);
  if (f.rollback) lines.push(`**Rollback.** ${f.rollback}`);
  lines.push(`**Verify.** ${f.verify}`);
  return lines.join('\n');
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 };
const bySeverity = (a: Finding, b: Finding): number => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);

export interface PlanMeta {
  packVersion: string;
  status: PlanStatus;
  /** Routing for this emit; without it every finding stays in its stage (the M6 layout). */
  routing?: Routing;
  thresholdSource?: 'default' | 'flag';
  /** Present only when the L1 verify loop ran. */
  verify?: readonly StageVerify[];
  /** Gate IDs that ran, for the footer. */
  gates?: readonly string[];
  engineVersion?: string;
  /** Repo hash at the scan and at this emit; null when not recorded. */
  repoHash?: { before: string | null; after: string | null };
}

function verifyLine(v: StageVerify | undefined): string {
  if (!v || v.decision === null) return 'not verified';
  const n = `${v.attempts} attempt${v.attempts === 1 ? '' : 's'}`;
  if (v.decision === 'kept') return `kept after ${n}`;
  if (v.decision === 'unresolved') return `unresolved after ${n}`;
  if (v.held_for_review.length) return `held for review by gate 7 after ${n}`;
  return `${v.decision} after ${n}`;
}

/** Renders the whole plan as Markdown. */
export function renderPlanMarkdown(plan: Plan, meta: PlanMeta): string {
  const byId = new Map(plan.findings.map((f) => [f.id, f]));
  const routing = meta.routing;
  const verifyById = new Map((meta.verify ?? []).map((v) => [v.stage_id, v]));
  const stages = [...plan.stages].sort((a, b) => a.order - b.order);
  const stageTitle = new Map(stages.map((s) => [s.id, `${s.order + 1}. ${s.title}`]));
  const out: string[] = [];
  out.push(`# Migration plan`);
  out.push('');
  out.push(`- Pack: \`${plan.pack}\``);
  out.push(`- Prompt: \`${plan.prompt_version}\``);
  out.push(`- Status: **${meta.status}**`);
  out.push('');

  // 1. Review first
  const review = routing?.review_first ?? [];
  if (review.length) {
    out.push(`## Review first (${review.length})`, '');
    out.push('Read these before anything else. They are listed here whatever their confidence.', '');
    for (const item of review) {
      if (item.finding_id) {
        const f = byId.get(item.finding_id);
        if (f) out.push(findingBlock(f, `${item.detail}; stage ${stageTitle.get(stages.find((s) => s.finding_ids.includes(f.id))?.id ?? '') ?? 'none'}`), '');
      } else if (item.stage_id) {
        out.push(`- **Stage ${stageTitle.get(item.stage_id) ?? item.stage_id}**: ${item.detail}. Patch: \`patches/needs-review/${item.stage_id}.patch\``);
      } else {
        out.push(`- \`${item.usage_id}\`: ${item.detail}`);
      }
    }
    out.push('');
  }

  // 2. Unresolved (M6 gates, and unresolved L1 stages)
  const l1Unresolved = (meta.verify ?? []).filter((v) => v.decision === 'unresolved');
  if (plan.unresolved.length || l1Unresolved.length) {
    out.push(`## Unresolved (${plan.unresolved.length + l1Unresolved.length})`, '');
    out.push('These failed a gate after the round or attempt cap and were not resolved. Review them before applying the plan.', '');
    for (const u of plan.unresolved) out.push(`- **${u.gate ?? 'gate'}**${u.finding_id ? ` (${u.finding_id})` : ''}: ${u.reason}`);
    for (const v of l1Unresolved) out.push(`- **verify** (stage ${stageTitle.get(v.stage_id) ?? v.stage_id}): rejected on all ${v.attempts} attempts; the sandbox was rolled back to the stage start`);
    out.push('');
  }

  // 3. Needs human decision
  const needs = routing?.needs_human ?? [];
  if (needs.length) {
    out.push(`## Needs human decision (${needs.length})`, '');
    out.push(`Confidence below ${routing!.threshold}. Decide whether each applies before following the plan.`, '');
    for (const id of needs) {
      const f = byId.get(id);
      if (f) out.push(findingBlock(f, `confidence ${f.confidence}`), '');
    }
  }

  // 4. Per-stage summary
  const lifted = new Set([...needs, ...review.flatMap((r) => (r.finding_id ? [r.finding_id] : []))]);
  out.push(`## Summary`, '');
  for (const stage of stages) {
    const fs = stage.finding_ids.map((id) => byId.get(id)).filter((f): f is Finding => f !== undefined);
    const codemods = fs.filter((f) => f.step_kind === 'codemod').length;
    const top = [...fs].sort(bySeverity)[0]?.severity;
    const moved = fs.filter((f) => lifted.has(f.id)).length;
    out.push(`${stage.order + 1}. **${stage.title}**: ${fs.length} finding${fs.length === 1 ? '' : 's'} (${codemods} codemod, ${fs.length - codemods} manual)${top ? `, highest ${top}` : ''}${moved ? `; ${moved} listed above` : ''}.`);
    if (meta.verify) out.push(`   Verify: ${verifyLine(verifyById.get(stage.id))}.`);
  }
  out.push('');

  // 5. Stage details
  out.push(`## Stages`, '');
  for (const stage of stages) {
    out.push(`### ${stage.order + 1}. ${stage.title}`);
    if (stage.depends_on.length) out.push(`_depends on: ${stage.depends_on.join(', ')}_`);
    out.push('');
    const ids = routing?.main[stage.id] ?? stage.finding_ids;
    const findings = ids
      .map((id) => byId.get(id))
      .filter((f): f is Finding => f !== undefined)
      .sort(bySeverity);
    const moved = stage.finding_ids.length - ids.length;
    if (!findings.length) out.push(moved ? '_Every finding in this stage is listed above._' : '_No findings in this stage._');
    else if (moved) out.push(`_${moved} more listed above._`, '');
    for (const f of findings) {
      out.push(findingBlock(f));
      out.push('');
    }
    if (!findings.length) out.push('');
  }

  if (plan.out_of_scope.length) {
    out.push(`## Out of scope (${plan.out_of_scope.length})`);
    out.push('');
    for (const o of plan.out_of_scope) out.push(`- \`${o.usage_id}\` — ${o.reason} _(by ${o.written_by})_`);
    out.push('');
  }

  // 6. Footer
  out.push('---');
  out.push('');
  const gates = meta.gates?.length ? `, gates ${meta.gates.join(', ')}${meta.engineVersion ? ` (engine ${meta.engineVersion})` : ''}` : '';
  const threshold = routing ? `, confidence threshold ${routing.threshold} (${meta.thresholdSource ?? 'default'})` : '';
  out.push(`Pack \`${plan.pack}\` version ${meta.packVersion}, prompt ${plan.prompt_version}${gates}${threshold}.`);
  const h = meta.repoHash;
  if (h?.before && h.after && h.before !== h.after) {
    out.push('The engine did not modify the target repo, but its files changed between the scan and this emit; re-run the plan on the current tree.');
  } else {
    out.push(`The target repo was not modified by this plan${h?.before && h.after ? ` (repo hash ${h.after.slice(0, 12)} before and after)` : ''}.`);
  }
  return out.join('\n') + '\n';
}
