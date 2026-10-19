import { z } from 'zod';

const VersionRef = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict();

/** A run, or a source and target with no repo. `present_only` needs the run, so the usages are known. */
export const GetRulePackInput = z
  .object({
    run_id: z.string().min(1).optional(),
    source: VersionRef.optional(),
    target: VersionRef.optional(),
    present_only: z.boolean().optional(),
  })
  .strict();
export type GetRulePackInput = z.infer<typeof GetRulePackInput>;

export const PackedRule = z.object({
  id: z.string(),
  library: z.string(),
  title: z.string(),
  event: z.string(),
  necessity: z.enum(['breaks', 'deprecated']),
  lands_on: z.enum(['source', 'target']),
  default_severity: z.string(),
  codemod: z.string().nullable(),
  source: z.string(),
});

export const GetRulePackOutput = z.object({
  pack: z.string(),
  supported: z.object({ from: z.string(), to: z.string() }),
  rules: z.array(PackedRule),
  codemods: z.array(z.object({ id: z.string(), rules: z.array(z.string()) }).strict()),
  notes: z.array(z.string()),
  references: z.array(z.string()),
});
export type GetRulePackOutput = z.infer<typeof GetRulePackOutput>;
