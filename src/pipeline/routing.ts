// Deterministic confidence routing (M9 task 1, PRD section 7). It runs on the
// plan validate_plan already gated, at emit, and only decides where each item
// is shown: "Review first", "Needs human decision" or the main plan stages.
// plan.json is not changed, so a routed finding has passed (or failed into
// unresolved[]) the same gates as any other; routing is never a bypass.
// Rules, in order:
//   1. Review first: a high or blocker finding whose source is agent_judgment
//      (whatever its confidence); an L1 stage gate 7 held for review; a usage
//      the scope excluded, or a lens marked out of scope, whose rule breaks.
//   2. Needs human decision: confidence below the threshold.
//   3. Everything else stays in its stage.
import type { ComposedRule } from '../rules/compose.js';
import { bindsTo } from '../rules/match.js';
import type { Finding } from '../schema/finding.js';
import type { Plan } from '../schema/plan.js';
import type { Usage } from '../schema/usage.js';
import type { CheckResult, Gate7Result, StageDecision } from '../schema/verify.js';

/** The default threshold. eval/threshold.md records why it has not been tuned (PRD section 7: "not by feel"). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export const SCOPE_BREAKS_LINE = 'excluded by your scope, but this breaks on the target';
export const LENS_BREAKS_LINE = 'marked as needing no change, but this rule breaks on the target';

const REVIEW_SEVERITIES = new Set<Finding['severity']>(['high', 'blocker']);

export type ReviewReason = 'agent_judgment' | 'gate7' | 'scope_breaks' | 'lens_breaks';

export interface ReviewItem {
  reason: ReviewReason;
  finding_id: string | null;
  stage_id: string | null;
  usage_id: string | null;
  detail: string;
}

/** What the L1 loop decided for one stage, read from the store at emit. */
export interface StageVerify {
  stage_id: string;
  /** The latest attempt's decision; null when the stage was never attempted. */
  decision: StageDecision | null;
  attempts: number;
  /** Gate 7 reasons of the attempts held for review (clean checks, gate 7 failed); empty when none. */
  held_for_review: string[];
}

export interface RoutingInput {
  plan: Plan;
  threshold: number;
  usages: readonly Usage[];
  /** The rules up to the original target, ignoring stop_at: what "breaks on the target" means for a scope exclusion. */
  targetRules: readonly ComposedRule[];
  /** The run's own rules (narrowed by stop_at): what a lens judged against. */
  runRules: readonly ComposedRule[];
  /** Present only when the L1 verify loop ran. */
  verify?: readonly StageVerify[];
}

export interface Routing {
  threshold: number;
  review_first: ReviewItem[];
  /** Finding IDs below the threshold, in plan order. */
  needs_human: string[];
  /** Stage ID -> the finding IDs left in that stage's main listing. */
  main: Record<string, string[]>;
}

/** A gate 7 hold: every check is clean but gate 7 failed. submit_stage_patch then exports the patch to patches/needs-review/. */
export function heldForReview(checks: readonly CheckResult[], gate7: Gate7Result): boolean {
  const clean = checks.every((c) => c.status === 'pass' || c.status === 'baseline_failing' || c.status === 'flaky');
  return clean && !gate7.pass;
}

/** True when some rule that binds the usage has necessity `breaks`. Flagging is the safe direction, so any breaking rule counts. */
export function usageBreaks(usage: Usage, rules: readonly ComposedRule[]): boolean {
  return usage.match_kind !== null && rules.some((r) => r.necessity === 'breaks' && bindsTo(r.rule.match, usage));
}

export function routePlan(input: RoutingInput): Routing {
  const { plan, threshold } = input;
  const review_first: ReviewItem[] = [];
  const needs_human: string[] = [];
  const routed = new Set<string>();

  for (const f of plan.findings) {
    if (REVIEW_SEVERITIES.has(f.severity) && f.source === 'agent_judgment') {
      review_first.push({ reason: 'agent_judgment', finding_id: f.id, stage_id: null, usage_id: null, detail: `${f.severity} finding from agent judgment` });
      routed.add(f.id);
    } else if (f.confidence < threshold) {
      needs_human.push(f.id);
      routed.add(f.id);
    }
  }

  for (const v of input.verify ?? []) {
    if (v.held_for_review.length && v.decision !== 'kept') {
      review_first.push({ reason: 'gate7', finding_id: null, stage_id: v.stage_id, usage_id: null, detail: `gate 7 held the patch for review: ${v.held_for_review.join('; ')}` });
    }
  }

  const usagesById = new Map(input.usages.map((u) => [u.id, u]));
  for (const o of plan.out_of_scope) {
    const u = usagesById.get(o.usage_id);
    if (!u) continue;
    const where = `${u.file}:${u.line_start}`;
    if (o.written_by === 'scope') {
      if (usageBreaks(u, input.targetRules)) review_first.push({ reason: 'scope_breaks', finding_id: null, stage_id: null, usage_id: u.id, detail: `${where} ${SCOPE_BREAKS_LINE} (${o.reason})` });
    } else if (o.written_by !== 'engine') {
      if (usageBreaks(u, input.runRules)) review_first.push({ reason: 'lens_breaks', finding_id: null, stage_id: null, usage_id: u.id, detail: `${where} ${LENS_BREAKS_LINE} (${o.written_by}: ${o.reason})` });
    }
  }

  const main: Record<string, string[]> = {};
  for (const s of plan.stages) main[s.id] = s.finding_ids.filter((id) => !routed.has(id));
  return { threshold, review_first, needs_human, main };
}
