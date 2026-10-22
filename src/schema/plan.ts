// The plan schema (M5). merge_findings (M6) is what fills stages, findings
// and unresolved. written_by is the scope, the engine, or the lens (D16).
import { z } from 'zod';
import { Finding, FindingLens } from './finding.js';

export const WrittenBy = z.enum(['scope', 'engine', 'api', 'dependency_build', 'behavior_runtime', 'verification', 'combined']);
export type WrittenBy = z.infer<typeof WrittenBy>;

export const OutOfScopeEntry = z
  .object({
    usage_id: z.string().min(1),
    reason: z.string().trim().min(1),
    written_by: WrittenBy,
  })
  .strict();
export type OutOfScopeEntry = z.infer<typeof OutOfScopeEntry>;

export const Stage = z
  .object({
    id: z.string().min(1),
    order: z.number().int(),
    title: z.string().min(1),
    finding_ids: z.array(z.string().min(1)),
    depends_on: z.array(z.string().min(1)),
  })
  .strict();
export type Stage = z.infer<typeof Stage>;

export const Unresolved = z
  .object({
    finding_id: z.string().nullable(),
    gate: z.string().nullable(),
    reason: z.string().min(1),
  })
  .strict();
export type Unresolved = z.infer<typeof Unresolved>;

export const Plan = z
  .object({
    run_id: z.string().min(1),
    campaign_id: z.string().min(1),
    repo_id: z.string().min(1),
    pack: z.string().min(1),
    prompt_version: z.string().min(1),
    stages: z.array(Stage),
    findings: z.array(Finding),
    out_of_scope: z.array(OutOfScopeEntry),
    unresolved: z.array(Unresolved),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

export const GetLensPacketInput = z
  .object({
    run_id: z.string().min(1),
    lens: FindingLens,
  })
  .strict();
export type GetLensPacketInput = z.infer<typeof GetLensPacketInput>;

/** The six gate IDs, in order. The interface is shared with gate 7 (M8). */
export const GateId = z.enum(['g1_evidence', 'g2_coverage', 'g3_doc_refs', 'g4_rollback_verify', 'g5_stage_order', 'g6_schema_ids']);
export type GateId = z.infer<typeof GateId>;

/**
 * One gate observation. `subject` names the finding or stage it is about, or
 * null for a whole-plan check. `expected`/`actual` make a failure
 * machine-readable (PRD section 7).
 */
export const GateResult = z
  .object({
    gate: GateId,
    subject: z.string().nullable(),
    pass: z.boolean(),
    reason: z.string().min(1),
    expected: z.string().optional(),
    actual: z.string().optional(),
  })
  .strict();
export type GateResult = z.infer<typeof GateResult>;

export const PlanStatus = z.enum(['draft', 'passed', 'failed', 'capped']);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const MergeFindingsInput = z.object({ run_id: z.string().min(1) }).strict();
export type MergeFindingsInput = z.infer<typeof MergeFindingsInput>;

/** A merge conflict kept for the run report: a severity/concern clash or two actions on one span. */
export const MergeConflict = z
  .object({
    kind: z.enum(['severity', 'concern', 'overlapping', 'lens_vs_finding', 'scope_vs_finding']),
    detail: z.string().min(1),
  })
  .strict();
export type MergeConflict = z.infer<typeof MergeConflict>;

export const MergeFindingsOutput = z
  .object({
    run_id: z.string(),
    round: z.number().int(),
    size: z.enum(['none', 'small', 'full']),
    plan: Plan,
    /** Usage IDs with no covering finding and no out-of-scope entry (gate 2's input). */
    uncovered_usages: z.array(z.string()),
    conflicts: z.array(MergeConflict),
    /** Findings kept out of the plan because scope left them covering no usage. */
    dropped_findings: z.array(z.string()),
  })
  .strict();
export type MergeFindingsOutput = z.infer<typeof MergeFindingsOutput>;

export const ValidatePlanInput = z.object({ run_id: z.string().min(1) }).strict();
export type ValidatePlanInput = z.infer<typeof ValidatePlanInput>;

export const ValidatePlanOutput = z
  .object({
    run_id: z.string(),
    round: z.number().int(),
    status: PlanStatus,
    passed: z.boolean(),
    capped: z.boolean().describe('True when round 3 was reached with failures; they are in unresolved and never passed.'),
    results: z.array(GateResult),
    unresolved: z.array(Unresolved),
  })
  .strict();
export type ValidatePlanOutput = z.infer<typeof ValidatePlanOutput>;

export const EmitPlanInput = z.object({ run_id: z.string().min(1) }).strict();
export type EmitPlanInput = z.infer<typeof EmitPlanInput>;

export const EmitPlanOutput = z
  .object({
    run_id: z.string(),
    round: z.number().int(),
    status: PlanStatus,
    /** Paths written, relative to the output folder. */
    plan_json: z.string(),
    plan_md: z.string(),
    unresolved: z.number().int(),
    /** run_report.md beside the plan (M9). */
    run_report: z.string(),
    /** One CHECKLIST.md per stage, under stages/<n>/. */
    checklists: z.array(z.string()),
    /** verify_report.json, written only when the L1 verify loop ran for this run. */
    verify_report: z.string().nullable(),
    routing: z
      .object({
        threshold: z.number(),
        threshold_source: z.enum(['default', 'flag']),
        review_first: z.number().int(),
        needs_human: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type EmitPlanOutput = z.infer<typeof EmitPlanOutput>;
