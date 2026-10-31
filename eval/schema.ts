// The eval data contracts (M7). All of eval/ is tooling outside the engine
// (src/ never imports it, INV-40): it writes files, runs git and reads
// recorded runs. These Zod schemas validate the committed case records, the
// derived truth, the recorded engine and baseline runs, and the removed-case
// list, so a malformed file fails loudly instead of silently skewing a score.
import { z } from 'zod';

/** A library at a commit: framework name plus the pinned version, as the M0 records use. */
export const CaseLib = z.object({ framework: z.string().min(1), version: z.string().min(1) }).strict();
export type CaseLib = z.infer<typeof CaseLib>;

/** The check commands a case's own repo uses (for M8 L1). Optional in M7. */
export const CaseChecks = z
  .object({
    install: z.array(z.string().min(1)).optional(),
    test: z.array(z.string().min(1)).optional(),
    typecheck: z.array(z.string().min(1)).optional(),
    lint: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CaseChecks = z.infer<typeof CaseChecks>;

/** A public GitHub repo, `https://github.com/<owner>/<repo>`, with nothing git could read as an option. */
export const GITHUB_REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
/** A full 40-hex commit SHA. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * eval/cases/<id>/case.json. The pinned fields (everything but `notes` and
 * `checks`) are frozen once a case has recorded runs (D15); the add-only check
 * enforces that. `base_commit` is the parent of the migration.
 */
export const Case = z
  .object({
    id: z.string().min(1),
    pack: z.string().min(1),
    // Maintainer tools pass these to git (cases:fetch, cases:verify, truth:derive),
    // so a case can name only a public GitHub repo and full commit SHAs: an
    // option-shaped URL could otherwise run a command, and a short SHA never
    // equals the full HEAD a checkout reports.
    repo_url: z.string().regex(GITHUB_REPO_URL),
    base_commit: z.string().regex(FULL_SHA),
    merge_commit: z.string().regex(FULL_SHA),
    pr_url: z.string().min(1),
    source: CaseLib,
    target: CaseLib,
    license: z.string().min(1),
    checks: CaseChecks.optional(),
    notes: z.string().optional(),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Case = z.infer<typeof Case>;

/** The three fields that identify a usage across adapter changes (D17): never the usage ID. */
export const UsageSpan = z
  .object({
    file: z.string().min(1),
    line_start: z.number().int(),
    line_end: z.number().int(),
    snippet_hash: z.string().regex(/^[a-f0-9]{64}$/, 'a sha256 hex digest'),
  })
  .strict();
export type UsageSpan = z.infer<typeof UsageSpan>;

/**
 * eval/cases/<id>/truth.json, derived deterministically by scripts/derive-truth.ts
 * and never re-derived for an existing case (D15). Each true changed usage is a
 * span the migration PR touched that mapped to a usage at base; `touched_files`
 * and `edit_size` feed file precision and severity calibration.
 */
export const Truth = z
  .object({
    case_id: z.string().min(1),
    base_commit: z.string().min(1),
    merge_commit: z.string().min(1),
    changed_usages: z.array(UsageSpan),
    touched_files: z.array(z.string().min(1)),
    /** Per-file edit size (added+removed source lines, lockfile churn excluded), for calibration. */
    edit_size: z.record(z.string(), z.number().int().nonnegative()),
    /** Manual exclusions recorded with a reason (noisy-truth mitigation, plan Risks). */
    excluded_files: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Truth = z.infer<typeof Truth>;

/** A reviewer's note that a real PR itself missed a required change (INV-30). Hand-written, add-only. */
export const Annotation = z
  .object({
    finding: z.string().min(1),
    reason: z.string().min(1),
    reviewer: z.string().min(1),
    date: z.string().min(1),
  })
  .strict();
export const Annotations = z.object({ entries: z.array(Annotation) }).strict();
export type Annotation = z.infer<typeof Annotation>;

/** The host that produced a run: product and model must match across a pack's runs; CLI version may differ. */
export const Host = z
  .object({
    product: z.string().min(1),
    model: z.string().min(1),
    cli_version: z.string().optional(),
  })
  .strict();
export type Host = z.infer<typeof Host>;

/** A recorded doc, replayed by re-registering it with no network (D17). */
export const RecordedDoc = z
  .object({
    library: z.string().min(1),
    version: z.string().min(1),
    topic: z.string().min(1),
    url: z.string().min(1),
    content: z.string().min(1),
    doc_id: z.string().min(1),
    fetched_by: z.enum(['agent', 'engine', 'knowledge']),
    official: z.boolean(),
    status: z.enum(['fresh', 'stale', 'unverified']),
  })
  .strict();
export type RecordedDoc = z.infer<typeof RecordedDoc>;

/** One lens submission exactly as the host agent made it, with the packet usage spans it carried. */
export const RecordedSubmission = z
  .object({
    lens: z.enum(['api', 'dependency_build', 'behavior_runtime', 'verification', 'combined']),
    /** The usage spans the packet carried, so replay can match recorded usage IDs to HEAD's. */
    packet_usages: z.array(UsageSpan.extend({ usage_id: z.string().min(1) }).strict()),
    /** The submit_findings argument, verbatim. usage_ids reference packet_usages by recorded ID. */
    submission: z.object({ findings: z.array(z.unknown()), out_of_scope: z.array(z.unknown()) }).strict(),
  })
  .strict();
export type RecordedSubmission = z.infer<typeof RecordedSubmission>;

/** One validate_plan round: the lens submissions in order, retry attempts included. */
export const RecordedRound = z.object({ submissions: z.array(RecordedSubmission) }).strict();
export type RecordedRound = z.infer<typeof RecordedRound>;

/**
 * eval/runs/<case>/<prompt_version>/<n>/run.json. Everything replay needs to
 * re-run HEAD's engine on fixed agent output, with no model and no network
 * (D17, INV-44): the ingest arguments, scope answers, docs, rounds, plus the
 * cost and wall time taken (never measured during re-scoring) and the host.
 */
export const EngineRun = z
  .object({
    kind: z.literal('engine'),
    case_id: z.string().min(1),
    prompt_version: z.string().min(1),
    run: z.number().int().positive(),
    /** The ingest arguments: source/target the agent gave scan_repo. */
    ingest: z.object({ source: z.record(z.string(), z.unknown()), target: z.record(z.string(), z.unknown()) }).strict(),
    /** The recorded set_scope answers; a key HEAD no longer offers takes the default (D17). */
    scope_answers: z.record(z.string(), z.unknown()),
    docs: z.array(RecordedDoc),
    rounds: z.array(RecordedRound),
    /** The recorded size and lens set; replay keeps them and does not re-run sizing (D17). */
    size: z.enum(['none', 'small', 'full']),
    cost_tokens: z.number().int().nonnegative().nullable(),
    wall_ms: z.number().int().nonnegative(),
    host: Host,
    transcript: z.string().optional(),
  })
  .strict();
export type EngineRun = z.infer<typeof EngineRun>;

/** A best-effort finding the baseline parser pulled from a Markdown plan. */
export const BaselineFinding = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive().nullable(),
    severity: z.enum(['info', 'low', 'medium', 'high', 'blocker']).nullable(),
  })
  .strict();
export type BaselineFinding = z.infer<typeof BaselineFinding>;

/** eval/runs/<case>/baseline/<n>/run.json. Re-scored from its recorded Markdown; there is no engine to re-run. */
export const BaselineRun = z
  .object({
    kind: z.literal('baseline'),
    case_id: z.string().min(1),
    run: z.number().int().positive(),
    /** The Markdown plan the host agent produced with no engine. */
    markdown: z.string(),
    /** The sha256 of eval/baseline/prompt.md this run was made with; must equal HEAD's at the gate (D17). */
    prompt_hash: z.string().regex(/^[a-f0-9]{64}$/, 'a sha256 hex digest'),
    cost_tokens: z.number().int().nonnegative().nullable(),
    wall_ms: z.number().int().nonnegative(),
    host: Host,
  })
  .strict();
export type BaselineRun = z.infer<typeof BaselineRun>;

/** eval/cases/REMOVED.json: the add-only list of removed cases (D15). Empty at first. */
export const RemovedEntry = z.object({ id: z.string().min(1), reason: z.string().min(1), pr: z.string().min(1) }).strict();
export const Removed = z.array(RemovedEntry);
export type RemovedEntry = z.infer<typeof RemovedEntry>;
