// Replay (M7 task 3, D17, INV-44). Re-runs a recorded engine run on HEAD's
// deterministic engine with no model and no network (Context7 is forced off),
// and scores the resulting plan against the case's truth. A recorded usage ID
// is matched to HEAD's usage by its recorded file, span and snippet_hash, never
// by ID, so renumbering IDs changes nothing. A recorded finding whose usage
// HEAD no longer finds is dropped and counts as a miss. Baseline runs are
// re-scored from their recorded Markdown, since there is no engine to re-run.
// Outside the engine: src/ never imports this (INV-40).
import {
  createEngine,
  closeEngine,
  getLensPacket,
  getMigrationDocs,
  mergeFindings,
  proposeScope,
  setScope,
  submitFindings,
  validatePlan,
  type Engine,
} from '../src/core/index.js';
import type { Usage } from '../src/schema/usage.js';
import type { Plan, ValidatePlanOutput } from '../src/schema/plan.js';
import { parseBaseline } from './baseline/parse.js';
import { REPLAY_DOCS, assertRepoUntouched, scanUsagesWith, tempOut } from './engineRun.js';
import { sameSpan, score, type Score, type ScoredFinding } from './metrics.js';
import type { BaselineRun, EngineRun, RecordedSubmission, Truth, UsageSpan } from './schema.js';

/** A note the report shows: replay followed the live flow but HEAD differed from the recording. */
export interface ReplayFlag {
  kind: 'size_differs' | 'scope_default' | 'submission_rejected' | 'doc_refused' | 'finding_dropped' | 'gates_capped';
  detail: string;
}

export interface EngineReplayResult {
  case_id: string;
  run: number;
  score: Score;
  flags: ReplayFlag[];
  cost_tokens: number | null;
  wall_ms: number;
  host: { product: string; model: string };
}

/** Map a recorded usage span to a HEAD usage ID, or null when HEAD no longer finds it. */
function headUsageId(span: UsageSpan, head: readonly Usage[]): string | null {
  const hit = head.find((u) => sameSpan({ file: u.file, line_start: u.line_start, line_end: u.line_end, snippet_hash: u.snippet_hash }, span));
  return hit ? hit.id : null;
}

/** The span of a HEAD usage. */
function spanOf(u: Usage): UsageSpan {
  return { file: u.file, line_start: u.line_start, line_end: u.line_end, snippet_hash: u.snippet_hash };
}

/**
 * Rewrite a recorded submission so its usage IDs name HEAD's usages. Each
 * recorded usage ID resolves through the packet's recorded span to a HEAD usage
 * ID; a finding whose usages have no HEAD match drops those IDs (and, if it is
 * left naming none, the finding is counted as a drop). Out-of-scope marks on a
 * vanished usage are dropped the same way.
 */
function remap(
  sub: RecordedSubmission,
  head: readonly Usage[],
): { submission: { findings: unknown[]; out_of_scope: unknown[] }; dropped: number } {
  const toHead = new Map<string, string | null>();
  for (const p of sub.packet_usages) toHead.set(p.usage_id, headUsageId(p, head));

  let dropped = 0;
  const findings = sub.submission.findings.map((raw) => {
    const f = raw as { usage_ids?: unknown; evidence?: unknown };
    if (!Array.isArray(f.usage_ids)) return raw;
    const mapped: string[] = [];
    for (const id of f.usage_ids as string[]) {
      const head = toHead.get(id);
      if (head) mapped.push(head);
    }
    if ((f.usage_ids as string[]).length > 0 && mapped.length === 0) dropped += 1;
    return { ...f, usage_ids: mapped };
  });
  const outOfScope = (sub.submission.out_of_scope as { usage_id?: unknown }[])
    .map((o) => ({ ...o, usage_id: typeof o.usage_id === 'string' ? toHead.get(o.usage_id) ?? null : null }))
    .filter((o) => o.usage_id !== null);
  return { submission: { findings, out_of_scope: outOfScope }, dropped };
}

const SEVERITY_RANK = ['info', 'low', 'medium', 'high', 'blocker'] as const;
function asSeverity(s: string): (typeof SEVERITY_RANK)[number] {
  return (SEVERITY_RANK as readonly string[]).includes(s) ? (s as (typeof SEVERITY_RANK)[number]) : 'info';
}

/**
 * Replay one recorded engine run and score it against truth. Runs HEAD's
 * engine over the base checkout with Context7 off: apply ingest + scope, register
 * every recorded doc with no network, then feed each round's lens submissions
 * (remapped to HEAD usage IDs) through get_lens_packet, submit_findings,
 * merge_findings and validate_plan, stopping at the first round HEAD's gates
 * pass. Later rounds are not fed (D17).
 */
export async function replayEngineRun(
  run: EngineRun,
  truth: Truth,
  baseCheckout: string,
  /** Test-only: extra docs options merged onto REPLAY_DOCS (e.g. a throwing `fetch` to prove no network). Never used in CI runs. */
  docsOverride?: Partial<NonNullable<typeof REPLAY_DOCS>>,
): Promise<EngineReplayResult> {
  const flags: ReplayFlag[] = [];
  const { out, cleanup } = tempOut();
  const engine: Engine = createEngine({ out, docs: { ...REPLAY_DOCS, ...docsOverride } });
  try {
    return await assertRepoUntouched(baseCheckout, () => replayInner(engine, run, truth, baseCheckout, flags));
  } finally {
    closeEngine(engine);
    cleanup();
  }
}

async function replayInner(engine: Engine, run: EngineRun, truth: Truth, baseCheckout: string, flags: ReplayFlag[]): Promise<EngineReplayResult> {
  {
    const source = run.ingest.source as { name: string };
    const target = run.ingest.target as { name: string; version: string };
    const scan = await scanUsagesWith(engine, baseCheckout, source, target);
    const runId = scan.run_id;
    const head = scan.usages;

    // Scope. A recorded answer HEAD no longer offers takes the default (D17).
    const proposal = await proposeScope(engine, { run_id: runId });
    const offered = new Set<string>(proposal.questions.map((q) => q.id));
    const answers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(run.scope_answers)) {
      if (offered.has(k)) answers[k] = v;
      else flags.push({ kind: 'scope_default', detail: `HEAD no longer offers scope question "${k}"; using the default` });
    }
    await setScope(engine, { run_id: runId, answers });

    // Docs. A recorded doc HEAD's version pin refuses is not registered (D17).
    for (const doc of run.docs) {
      try {
        await getMigrationDocs(engine, {
          run_id: runId,
          register: [{ library: doc.library, version: doc.version, topic: doc.topic, url: doc.url, content: doc.content }],
        });
      } catch (err) {
        flags.push({ kind: 'doc_refused', detail: `HEAD refused doc ${doc.library}@${doc.version} (${doc.url}): ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // Rounds, in order, until HEAD's gates pass or the recording runs out.
    let droppedFindings = 0;
    let scored: Awaited<ReturnType<typeof scorePlan>> | null = null;
    for (const round of run.rounds) {
      const byLens = new Map<RecordedSubmission['lens'], RecordedSubmission[]>();
      for (const s of round.submissions) {
        const list = byLens.get(s.lens) ?? [];
        list.push(s);
        byLens.set(s.lens, list);
      }
      for (const [lens, subs] of byLens) {
        try {
          await getLensPacket(engine, { run_id: runId, lens });
        } catch {
          continue; // HEAD refuses this lens at this size; the recording's lens set differs.
        }
        for (const sub of subs) {
          const { submission, dropped } = remap(sub, head);
          droppedFindings += dropped;
          const result = await submitFindings(engine, { run_id: runId, lens, ...submission });
          if (!result.accepted && !result.gap) {
            flags.push({ kind: 'submission_rejected', detail: `HEAD rejected a ${lens} submission; using the retry policy` });
          }
        }
      }
      const merged = await mergeFindings(engine, { run_id: runId });
      const validated = await validatePlan(engine, { run_id: runId });
      scored = await scorePlan(merged.plan, validated, head, truth, droppedFindings);
      if (validated.passed) break;
      if (validated.capped) {
        flags.push({ kind: 'gates_capped', detail: 'HEAD gates did not pass within the round cap; failures went to unresolved' });
        break;
      }
    }
    if (!scored) throw new Error(`engine run ${run.case_id}#${run.run} recorded no rounds`);
    for (let i = 0; i < scored.dropped; i++) flags.push({ kind: 'finding_dropped', detail: 'a recorded finding has no matching HEAD usage; counted as a miss' });
    if (run.size !== proposal.size) flags.push({ kind: 'size_differs', detail: `recorded size ${run.size}, HEAD sizes ${proposal.size}; replayed at the recorded set` });

    return {
      case_id: run.case_id,
      run: run.run,
      score: scored.score,
      flags,
      cost_tokens: run.cost_tokens,
      wall_ms: run.wall_ms,
      host: { product: run.host.product, model: run.host.model },
    };
  }
}

/** Score a validated plan against truth: cover truth usages via the plan's findings' HEAD usages. */
async function scorePlan(
  plan: Plan,
  validated: ValidatePlanOutput,
  head: readonly Usage[],
  truth: Truth,
  droppedFindings: number,
): Promise<{ score: Score; dropped: number }> {
  const headById = new Map(head.map((u) => [u.id, u]));
  // Gate 1 passed per finding = evidence all resolves (INV-15).
  const g1Fail = new Set(validated.results.filter((r) => r.gate === 'g1_evidence' && !r.pass && r.subject).map((r) => r.subject as string));
  const scored: ScoredFinding[] = plan.findings.map((f) => {
    const spans = f.usage_ids.map((id) => headById.get(id)).filter((u): u is Usage => u !== undefined).map(spanOf);
    const files = [...new Set([...spans.map((s) => s.file), ...f.evidence.map((e) => e.file)])];
    return {
      spans,
      severity: asSeverity(f.severity),
      evidence_valid: !g1Fail.has(f.id),
      proposes_change: f.concern !== 'behavior_change' || f.evidence.length > 0,
      files,
      confidence: f.confidence,
    };
  });
  const oos: { usage: UsageSpan; written_by: string }[] = [];
  for (const o of plan.out_of_scope) {
    const u = headById.get(o.usage_id);
    if (u) oos.push({ usage: spanOf(u), written_by: o.written_by });
  }
  const s = score({
    truth: truth.changed_usages,
    truth_files: truth.touched_files,
    edit_size: truth.edit_size,
    findings: scored,
    out_of_scope: oos,
    unresolved: plan.unresolved.length,
    dropped_findings: droppedFindings,
  });
  return { score: s, dropped: droppedFindings };
}

export interface BaselineReplayResult {
  case_id: string;
  run: number;
  score: Score;
  prompt_hash: string;
  cost_tokens: number | null;
  wall_ms: number;
  host: { product: string; model: string };
}

/**
 * Re-score a baseline run from its recorded Markdown (no engine to re-run). The
 * baseline covers a truth usage when it cites that usage's file; a citation to
 * a file not in the base tree is invalid, not skipped (plan task 4).
 */
export function replayBaselineRun(run: BaselineRun, truth: Truth, baseFiles: ReadonlySet<string>): BaselineReplayResult {
  const parsed = parseBaseline(run.markdown, baseFiles);
  // A baseline finding "covers" a truth usage when it cites the usage's file.
  const scored: ScoredFinding[] = parsed.findings.map((f) => ({
    spans: truth.changed_usages.filter((t) => t.file === f.file),
    severity: f.severity ?? 'info',
    evidence_valid: true, // the citation resolved (it is in baseFiles)
    proposes_change: true,
    files: [f.file],
    confidence: 1,
  }));
  // Invalid citations are counted as change findings with no valid evidence (evidence validity target 100%).
  for (const _ of parsed.invalid) scored.push({ spans: [], severity: 'info', evidence_valid: false, proposes_change: true, files: [], confidence: 1 });
  const s = score({
    truth: truth.changed_usages,
    truth_files: truth.touched_files,
    edit_size: truth.edit_size,
    findings: scored,
    out_of_scope: [],
    unresolved: 0,
    dropped_findings: 0,
  });
  return { case_id: run.case_id, run: run.run, score: s, prompt_hash: run.prompt_hash, cost_tokens: run.cost_tokens, wall_ms: run.wall_ms, host: { product: run.host.product, model: run.host.model } };
}
