// record_feedback (M9 task 6). Feedback on a run becomes a stored entry and an
// exported eval-case file. A `missing` entry may name a file and line, which
// must resolve inside the repo (SafePath). No training, no network.
import { z } from 'zod';

export const FeedbackKind = z.enum(['wrong', 'missing', 'severity_wrong', 'bad_patch', 'other']);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const RecordFeedbackInput = z
  .object({
    run_id: z.string().min(1),
    finding_id: z.string().min(1).optional(),
    stage_id: z.string().min(1).optional(),
    kind: FeedbackKind,
    note: z.string().trim().min(1).max(4000),
    file: z.string().min(1).optional().describe('Only for kind missing: the repo file the plan missed. Must be inside the repo.'),
    line: z.number().int().positive().optional().describe('Only for kind missing: the line in that file.'),
  })
  .strict();
export type RecordFeedbackInput = z.infer<typeof RecordFeedbackInput>;

/** The exported file, `<out>/eval/feedback/<run_id>-<n>.json`, which scripts/feedback-to-case.ts reads. */
export const FeedbackExport = z
  .object({
    format: z.literal('migration-planner-feedback@1'),
    run_id: z.string(),
    n: z.number().int().positive(),
    campaign_id: z.string(),
    repo_id: z.string(),
    pack: z.string().nullable(),
    source: z.object({ name: z.string(), version: z.string() }).strict(),
    target: z.object({ name: z.string(), version: z.string() }).strict(),
    prompt_version: z.string().nullable(),
    kind: FeedbackKind,
    note: z.string(),
    finding_id: z.string().nullable(),
    stage_id: z.string().nullable(),
    /** Repo-relative, POSIX, already checked against the repo boundary. */
    file: z.string().nullable(),
    line: z.number().int().nullable(),
    /** The finding as the plan held it, so a reviewer sees what the feedback is about. */
    finding: z
      .object({
        id: z.string(),
        severity: z.string(),
        rule_id: z.string().nullable(),
        evidence: z.array(z.object({ file: z.string(), line_start: z.number().int(), line_end: z.number().int() }).strict()),
      })
      .strict()
      .nullable(),
    created_at: z.string(),
  })
  .strict();
export type FeedbackExport = z.infer<typeof FeedbackExport>;

export const RecordFeedbackOutput = z
  .object({
    run_id: z.string(),
    n: z.number().int(),
    kind: FeedbackKind,
    /** Path written, relative to the output folder. */
    export_path: z.string(),
  })
  .strict();
export type RecordFeedbackOutput = z.infer<typeof RecordFeedbackOutput>;
