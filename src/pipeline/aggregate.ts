// The deterministic aggregator (M6 task 1). It dedupes findings, resolves
// severity and scope conflicts, stages the work via the import graph under the
// pack's staging strategy, and flags uncovered usages. It builds the `none`
// plan itself. It writes no files and runs no model; every merge and conflict
// is an event for the run report (docs/design.md D16, D5).
import { normalizeSnippet } from '../analysis/snippet.js';
import type { ComposedRule, PackComposition } from '../rules/compose.js';
import { bindsTo } from '../rules/match.js';
import type { Finding } from '../schema/finding.js';
import type { Severity } from '../schema/knowledge.js';
import type { MergeConflict, OutOfScopeEntry, Plan, Stage, WrittenBy } from '../schema/plan.js';
import type { Usage } from '../schema/usage.js';
import type { ImportRow } from '../store/usages.js';

const RANK: readonly Severity[] = ['info', 'low', 'medium', 'high', 'blocker'];
const higher = (a: Severity, b: Severity): Severity => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

/** The dedupe action normaliser: lowercase, collapse whitespace, strip punctuation. */
export function normaliseAction(action: string): string {
  return normalizeSnippet(action)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type LensMark = { lens: string; usage_id: string; reason: string };
export type ScopeExclusion = { usage_id: string; reason: string };

export interface AggregateInput {
  runId: string;
  campaignId: string;
  repoId: string;
  packRef: string;
  promptVersion: string;
  size: 'none' | 'small' | 'full';
  findings: readonly Finding[];
  marks: readonly LensMark[];
  scopeExcluded: readonly ScopeExclusion[];
  usages: readonly Usage[];
  imports: readonly ImportRow[];
  composed: PackComposition;
  staging: 'leaf_first' | 'config_first';
  kind: 'upgrade' | 'swap';
  /** The templated version-bump finding the engine builds (shared by `none` and full). */
  bumpFinding: Finding;
  /** Behaviour-change rules listed on a `none` plan. */
  hiddenBehavior: readonly { id: string; title: string }[];
}

export interface AggregateResult {
  plan: Plan;
  uncovered: string[];
  conflicts: MergeConflict[];
  droppedFindings: string[];
  /** finding id -> where it lands, for gate 5 (the engine derives it, the gate only checks). */
  landsOn: Map<string, 'source' | 'target'>;
  bumpStageId: string | null;
}

export const BUMP_STAGE_ID = 'stage-bump';

function rulesOf(composed: PackComposition): ComposedRule[] {
  return composed.libraries.flatMap((l) => l.rules);
}

/** Where a finding lands: its own rule's `lands_on`, else any source rule its usages bind, else target (D5). */
export function landsOnOf(finding: Finding, usagesById: ReadonlyMap<string, Usage>, rules: readonly ComposedRule[]): 'source' | 'target' {
  if (finding.rule_id) {
    const own = rules.find((r) => r.rule.id === finding.rule_id);
    if (own) return own.lands_on;
  }
  for (const id of finding.usage_ids) {
    const u = usagesById.get(id);
    if (!u || u.match_kind === null) continue;
    for (const r of rules) if (r.lands_on === 'source' && bindsTo(r.rule.match, u)) return 'source';
  }
  return 'target';
}

interface Merged {
  finding: Finding;
  overlapping: boolean;
}

/** Dedupes by span then normalised action. Same key merges; same span, other action is overlapping. */
export function dedupe(findings: readonly Finding[], conflicts: MergeConflict[]): Merged[] {
  const bySpan = new Map<string, Finding[]>();
  for (const f of findings) {
    const span = `${f.repo_id}\n${f.evidence[0]?.file ?? ''}\n${f.evidence[0]?.line_start ?? 0}\n${f.evidence[0]?.line_end ?? 0}`;
    (bySpan.get(span) ?? bySpan.set(span, []).get(span)!).push(f);
  }
  const out: Merged[] = [];
  for (const group of bySpan.values()) {
    const byAction = new Map<string, Finding[]>();
    for (const f of group) {
      const key = normaliseAction(f.action);
      (byAction.get(key) ?? byAction.set(key, []).get(key)!).push(f);
    }
    const actions = [...byAction.values()];
    for (const same of actions) {
      let merged = same[0]!;
      for (const other of same.slice(1)) {
        if (other.severity !== merged.severity) {
          conflicts.push({ kind: 'severity', detail: `${merged.id} and ${other.id} share a span and action but differ in severity (${merged.severity} vs ${other.severity}); taking the higher` });
        }
        if (other.concern !== merged.concern) {
          conflicts.push({ kind: 'concern', detail: `${merged.id} and ${other.id} share a span and action but differ in concern (${merged.concern} vs ${other.concern})` });
        }
        merged = {
          ...merged,
          severity: higher(merged.severity, other.severity),
          reasoning: merged.reasoning === other.reasoning ? merged.reasoning : `${merged.reasoning}\n\n${other.reasoning}`,
          usage_ids: [...new Set([...merged.usage_ids, ...other.usage_ids])],
          doc_refs: dedupeDocRefs([...merged.doc_refs, ...other.doc_refs]),
        };
      }
      out.push({ finding: merged, overlapping: actions.length > 1 });
    }
    if (actions.length > 1) {
      conflicts.push({ kind: 'overlapping', detail: `${group.length} findings touch the same span with different actions; all kept for review (${group.map((f) => f.id).join(', ')})` });
    }
  }
  return out;
}

function dedupeDocRefs(refs: Finding['doc_refs']): Finding['doc_refs'] {
  const seen = new Set<string>();
  const out: Finding['doc_refs'] = [];
  for (const r of refs) {
    const key = `${r.doc_id}\n${r.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** file -> files that import it (resolved edges), for leaf/entry ordering. */
function importersOf(imports: readonly ImportRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of imports) {
    if (!e.to_file) continue;
    (out.get(e.to_file) ?? out.set(e.to_file, new Set()).get(e.to_file)!).add(e.from_file);
  }
  return out;
}

const isEntrypoint = (file: string): boolean =>
  /(^|\/)middleware\.(js|jsx|ts|tsx|mjs)$/.test(file) || /(^|\/)(page|layout|route)\.(js|jsx|ts|tsx|mjs)$/.test(file);
const isConfig = (file: string): boolean => /(^|\/)(next\.config|tsconfig|jsconfig)\.[^/]*$/.test(file) || /\.config\.[cm]?[jt]s$/.test(file);

/**
 * A sort rank within a stage for the leaf-first strategy: leaf modules (nothing
 * imports them, or they import nothing in-repo) before importers, entrypoints
 * last. config_first lifts config to the very front. Lower sorts earlier.
 */
function fileRank(file: string, importers: Map<string, Set<string>>, strategy: 'leaf_first' | 'config_first'): number {
  if (strategy === 'config_first' && isConfig(file)) return -1;
  if (isEntrypoint(file)) return 2;
  // A file imported by others is a dependency of them: it must land first.
  return importers.has(file) ? 0 : 1;
}

/** codemod steps before manual steps, then by file rank, then by id (deterministic). */
function orderFindings(findings: readonly Finding[], importers: Map<string, Set<string>>, strategy: 'leaf_first' | 'config_first'): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.step_kind !== b.step_kind) return a.step_kind === 'codemod' ? -1 : 1;
    const ra = fileRank(a.evidence[0]?.file ?? '', importers, strategy);
    const rb = fileRank(b.evidence[0]?.file ?? '', importers, strategy);
    if (ra !== rb) return ra - rb;
    const fa = a.evidence[0]?.file ?? '';
    const fb = b.evidence[0]?.file ?? '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Resolves the out-of-scope entries with precedence scope > engine > lens, and
 * reconciles findings with scope exclusions and lens marks (D16). Returns the
 * entries, the conflicts, and the set of usage IDs each finding must drop
 * because the scope excluded them.
 */
function resolveOutOfScope(
  input: AggregateInput,
  findings: readonly Finding[],
  conflicts: MergeConflict[],
): { entries: OutOfScopeEntry[]; drop: Map<string, Set<string>>; coveredByFinding: Set<string> } {
  const rules = rulesOf(input.composed);
  const excludedIds = new Set(input.scopeExcluded.map((e) => e.usage_id));
  const drop = new Map<string, Set<string>>();

  // A finding that still covers a scope-excluded usage loses that usage (the
  // scope entry stands), with a conflict event.
  const coveredByFinding = new Set<string>();
  for (const f of findings) {
    for (const id of f.usage_ids) {
      if (excludedIds.has(id)) {
        (drop.get(f.id) ?? drop.set(f.id, new Set()).get(f.id)!).add(id);
        conflicts.push({ kind: 'scope_vs_finding', detail: `${f.id} covers ${id}, which the scope excluded; the usage is removed from the finding and kept out of scope` });
      } else {
        coveredByFinding.add(id);
      }
    }
  }

  const entries: OutOfScopeEntry[] = [];
  const takenReason = new Map<string, string>(); // usage_id -> reason already placed, to log extras

  const place = (usageId: string, reason: string, writtenBy: WrittenBy): void => {
    if (takenReason.has(usageId)) return; // precedence already placed one; caller logs the extra
    entries.push({ usage_id: usageId, reason, written_by: writtenBy });
    takenReason.set(usageId, reason);
  };

  // 1. scope wins.
  for (const e of input.scopeExcluded) place(e.usage_id, e.reason, 'scope');

  // 2. engine `no rule in range` for any usage that matches no composed rule
  //    and that no finding covers (every run size, D16).
  for (const u of input.usages) {
    if (coveredByFinding.has(u.id)) continue;
    const matched = u.match_kind !== null && rules.some((r) => bindsTo(r.rule.match, u));
    if (!matched && !takenReason.has(u.id)) place(u.id, 'no rule in range', 'engine');
  }

  // 3. lens marks, unless scope/engine already placed one, a finding covers it
  //    (finding outranks a mark), or two lenses collide.
  const seenLensUsage = new Set<string>();
  for (const m of input.marks) {
    if (coveredByFinding.has(m.usage_id)) {
      conflicts.push({ kind: 'lens_vs_finding', detail: `lens ${m.lens} marked ${m.usage_id} out of scope, but a finding covers it; the finding wins and the mark is dropped` });
      continue;
    }
    if (takenReason.has(m.usage_id)) continue; // scope or engine already placed it
    if (seenLensUsage.has(m.usage_id)) {
      conflicts.push({ kind: 'lens_vs_finding', detail: `more than one lens marked ${m.usage_id} out of scope; the first stands` });
      continue;
    }
    seenLensUsage.add(m.usage_id);
    place(m.usage_id, m.reason, m.lens as WrittenBy);
  }

  return { entries, drop, coveredByFinding };
}

interface StageDraft {
  id: string;
  title: string;
  findings: Finding[];
}

/** Builds the plan's stages: prep (lands_on source) first, the bump stage, then target work. */
function stageFindings(
  input: AggregateInput,
  prep: readonly Finding[],
  target: readonly Finding[],
  bump: Finding,
  importers: Map<string, Set<string>>,
): { stages: Stage[]; bumpStageId: string } {
  const drafts: StageDraft[] = [];
  const ordered = (fs: readonly Finding[]): Finding[] => orderFindings(fs, importers, input.staging);

  if (prep.length) drafts.push({ id: 'stage-prep', title: 'Prepare: fixes that work on the current version', findings: ordered(prep) });
  const bumpTitle = input.kind === 'swap' ? 'Add the new dependency alongside the old one' : `Bump the dependency and resolve peer conflicts`;
  drafts.push({ id: BUMP_STAGE_ID, title: bumpTitle, findings: [bump] });
  if (target.length) drafts.push({ id: 'stage-apply', title: 'Apply the changes on the new version', findings: ordered(target) });

  const stages: Stage[] = drafts.map((d, order) => ({
    id: d.id,
    order,
    title: d.title,
    finding_ids: d.findings.map((f) => f.id),
    depends_on: order === 0 ? [] : [drafts[order - 1]!.id],
  }));
  return { stages, bumpStageId: BUMP_STAGE_ID };
}

/** Runs the full aggregation for one run and returns the plan plus the report facts. */
export function aggregate(input: AggregateInput): AggregateResult {
  const conflicts: MergeConflict[] = [];
  const usagesById = new Map(input.usages.map((u) => [u.id, u]));
  const rules = rulesOf(input.composed);

  // 1. dedupe the submitted findings.
  const merged = dedupe(input.findings, conflicts);

  // 2. resolve out-of-scope and reconcile with findings.
  const resolved = resolveOutOfScope(input, merged.map((m) => m.finding), conflicts);

  // 3. drop scope-excluded usages from findings; a finding left with no usage
  //    and no evidence-only judgment is kept out of the plan and reported.
  const droppedFindings: string[] = [];
  const kept: Finding[] = [];
  for (const m of merged) {
    const toDrop = resolved.drop.get(m.finding.id);
    const usage_ids = toDrop ? m.finding.usage_ids.filter((id) => !toDrop.has(id)) : m.finding.usage_ids;
    if (toDrop && usage_ids.length === 0 && m.finding.source !== 'agent_judgment') {
      droppedFindings.push(m.finding.id);
      continue;
    }
    kept.push({ ...m.finding, usage_ids });
  }

  // 4. derive lands_on for the kept findings and split prep vs target.
  const landsOn = new Map<string, 'source' | 'target'>();
  for (const f of kept) landsOn.set(f.id, landsOnOf(f, usagesById, rules));
  landsOn.set(input.bumpFinding.id, 'source');
  const prep = kept.filter((f) => landsOn.get(f.id) === 'source');
  const target = kept.filter((f) => landsOn.get(f.id) !== 'source');

  // 5. stage.
  const importers = importersOf(input.imports);
  const { stages, bumpStageId } = stageFindings(input, prep, target, input.bumpFinding, importers);

  const findings = [...prep, input.bumpFinding, ...target];
  const uncovered = coverageGaps(input.usages, findings, resolved.entries);

  const plan: Plan = {
    run_id: input.runId,
    campaign_id: input.campaignId,
    repo_id: input.repoId,
    pack: input.packRef,
    prompt_version: input.promptVersion,
    stages,
    findings,
    out_of_scope: resolved.entries.sort((a, b) => (a.usage_id < b.usage_id ? -1 : a.usage_id > b.usage_id ? 1 : 0)),
    unresolved: [],
  };
  return { plan, uncovered, conflicts, droppedFindings, landsOn, bumpStageId };
}

/** Builds the `none` plan: one bump stage, the engine's reason on every usage, and the behaviour list. */
export function aggregateNone(input: AggregateInput): AggregateResult {
  const conflicts: MergeConflict[] = [];
  // Scope entries first, then the engine's `no rule in range` on every other usage.
  const entries: OutOfScopeEntry[] = [];
  const taken = new Set<string>();
  for (const e of input.scopeExcluded) {
    entries.push({ usage_id: e.usage_id, reason: e.reason, written_by: 'scope' });
    taken.add(e.usage_id);
  }
  for (const u of input.usages) {
    if (taken.has(u.id)) continue;
    entries.push({ usage_id: u.id, reason: 'no rule in range', written_by: 'engine' });
    taken.add(u.id);
  }
  // Behaviour changes with no syntax change (propose_scope's hidden list) ride
  // along as info findings with no evidence, so the none plan names them for the
  // reader. They pass the gates: info needs no rollback (gate 4), empty evidence
  // resolves vacuously (gate 1) and covers no usage (gate 2).
  const behaviorFindings: Finding[] = input.hiddenBehavior.map((b) => behaviorFinding(input, b));
  const findings = [input.bumpFinding, ...behaviorFindings];
  const stages: Stage[] = [
    { id: BUMP_STAGE_ID, order: 0, title: input.kind === 'swap' ? 'Add the new dependency' : 'Bump the dependency', finding_ids: findings.map((f) => f.id), depends_on: [] },
  ];
  const plan: Plan = {
    run_id: input.runId,
    campaign_id: input.campaignId,
    repo_id: input.repoId,
    pack: input.packRef,
    prompt_version: input.promptVersion,
    stages,
    findings,
    out_of_scope: entries.sort((a, b) => (a.usage_id < b.usage_id ? -1 : a.usage_id > b.usage_id ? 1 : 0)),
    unresolved: [],
  };
  const landsOn = new Map<string, 'source' | 'target'>(findings.map((f) => [f.id, 'source' as const]));
  return { plan, uncovered: coverageGaps(input.usages, plan.findings, entries), conflicts, droppedFindings: [], landsOn, bumpStageId: BUMP_STAGE_ID };
}

/** An info finding naming a behaviour change the none plan should flag, with no file evidence. */
function behaviorFinding(input: AggregateInput, b: { id: string; title: string }): Finding {
  return {
    id: `behavior-${b.id}`,
    repo_id: input.repoId,
    lens: 'combined',
    concern: 'behavior_change',
    severity: 'info',
    evidence: [],
    doc_refs: [],
    reasoning: `${b.title}. This changes behaviour without a syntax change, so there is nothing to edit; confirm it is acceptable.`,
    action: `Review the behaviour change: ${b.title}.`,
    step_kind: 'manual',
    verify: 'Confirm the behaviour change is acceptable after the bump.',
    confidence: 1,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: input.promptVersion,
  };
}

/** Usage IDs covered by no finding and no out-of-scope entry (gate 2's input). */
function coverageGaps(usages: readonly Usage[], findings: readonly Finding[], entries: readonly OutOfScopeEntry[]): string[] {
  const covered = new Set<string>();
  for (const f of findings) for (const id of f.usage_ids) covered.add(id);
  const scoped = new Set(entries.filter((e) => e.reason.trim() !== '').map((e) => e.usage_id));
  return usages.filter((u) => !covered.has(u.id) && !scoped.has(u.id)).map((u) => u.id);
}
