// Ingest input and the structured questions it returns instead of guessing.
// No schema here has a level field: a tool argument can never raise the level (C5).
import { z } from 'zod';

export const LibraryRef = z
  .object({
    name: z.string().trim().min(1).optional().describe('Library name as declared in the repo, for example "next" or "django".'),
    version: z.string().trim().min(1).optional().describe('Version. For the source it is checked against the lockfile; for the target it is required.'),
  })
  .strict();
export type LibraryRef = z.infer<typeof LibraryRef>;

export const IngestInput = z
  .object({
    repo_path: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .describe('Path to the repo. Exactly one: multi-repo campaigns are not built in v0.1.'),
    source: LibraryRef.optional().describe('The library and version installed now.'),
    target: LibraryRef.optional().describe('The library and version to move to.'),
    campaign_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional()
      .describe('Campaign to file the run under; created if absent.'),
  })
  .strict();
export type IngestInput = z.infer<typeof IngestInput>;

export const QuestionKind = z.enum(['vague_input', 'ambiguous_version', 'unresolved_version', 'version_mismatch']);

export const Question = z.object({
  kind: QuestionKind,
  field: z.string(),
  message: z.string(),
  candidates: z.array(z.object({ value: z.string(), where: z.array(z.string()) })),
});
export type Question = z.infer<typeof Question>;

export const RunRef = z.object({
  run_id: z.string(),
  campaign_id: z.string(),
  repo_id: z.string(),
});
export type RunRef = z.infer<typeof RunRef>;

export const Versions = z.object({
  source: z.object({ name: z.string(), version: z.string() }),
  target: z.object({ name: z.string(), version: z.string() }),
});
export type Versions = z.infer<typeof Versions>;

export const GitState = z.object({
  is_repo: z.boolean(),
  head_ref: z.string().nullable(),
  head_commit: z.string().nullable(),
  /** Always "unknown" in v0.1: finding out would mean running git or hashing every tracked file. */
  dirty: z.literal('unknown'),
});
export type GitState = z.infer<typeof GitState>;
