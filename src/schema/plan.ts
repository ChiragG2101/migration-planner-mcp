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
