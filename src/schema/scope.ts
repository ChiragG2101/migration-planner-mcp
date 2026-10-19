// Scope proposal and the answers set_scope accepts. The object is strict, so
// an answer cannot carry a path, a deny entry, the level, the checks or
// --out (the scope-cannot-widen permissions test).
import { z } from 'zod';

export const ScopeQuestionId = z.enum(['targets', 'stop_at', 'include_deprecated', 'depth']);
export type ScopeQuestionId = z.infer<typeof ScopeQuestionId>;

export const ScopeOption = z.object({ id: z.string(), label: z.string() }).strict();

export const ScopeQuestion = z.object({
  id: ScopeQuestionId,
  prompt: z.string(),
  options: z.array(ScopeOption).min(1),
  /** One option id, or several for `targets` (the default is every package). */
  default: z.union([z.string(), z.array(z.string())]),
});
export type ScopeQuestion = z.infer<typeof ScopeQuestion>;

export const ScopeAnswers = z
  .object({
    targets: z.array(z.string()).optional(),
    stop_at: z.string().optional(),
    include_deprecated: z.enum(['yes', 'no']).optional(),
    depth: z.enum(['none', 'small', 'full']).optional(),
  })
  .strict();
export type ScopeAnswers = z.infer<typeof ScopeAnswers>;

export const SetScopeInput = z.object({ run_id: z.string().min(1), answers: ScopeAnswers }).strict();
export type SetScopeInput = z.infer<typeof SetScopeInput>;

export const ProposeScopeInput = z
  .object({
    run_id: z.string().min(1),
    small_max_usages: z.number().int().positive().optional().describe('Matched usages at or under this, all codemod-covered and none high, size as small. Default 10.'),
  })
  .strict();
export type ProposeScopeInput = z.infer<typeof ProposeScopeInput>;

export const Size = z.enum(['none', 'small', 'full']);
export type Size = z.infer<typeof Size>;

export const OutOfScope = z.object({ usage_id: z.string(), written_by: z.literal('scope'), reason: z.string() }).strict();

export const ProposeScopeOutput = z.object({
  run_id: z.string(),
  size: Size,
  reasons: z.array(z.string()),
  questions: z.array(ScopeQuestion),
  /** Changed-behaviour rules not found in the code, listed when the size is none. */
  hidden_behavior: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
  info: z.object({ level: z.number(), checks_declared: z.boolean() }).strict(),
  small_max_usages: z.number(),
});
export type ProposeScopeOutput = z.infer<typeof ProposeScopeOutput>;

export const SetScopeOutput = z.object({
  run_id: z.string(),
  size: Size,
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** Question ids that took their default because the answer was omitted. */
  defaults: z.array(z.string()),
  out_of_scope: z.array(OutOfScope),
});
export type SetScopeOutput = z.infer<typeof SetScopeOutput>;
