// Verify loop schemas (M8): check config, sandbox, codemod registry, stage
// attempts, gate 7 results, and the tool I/O types.
import { z } from 'zod';
import { ReportedTokens } from './finding.js';

// ---------------------------------------------------------------------------
// Check config
// ---------------------------------------------------------------------------

/** One user-declared check command, frozen at startup (D44). */
export const CheckConfig = z
  .object({
    name: z.string().min(1),
    /** argv — never a shell string. The user writes `sh -c "..."` if they want a shell. */
    argv: z.array(z.string().min(1)).min(1),
    /** Optional JUnit XML output path (relative to sandbox root) for per-test results. */
    junit_path: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();
export type CheckConfig = z.infer<typeof CheckConfig>;

export const InstallConfig = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive().default(300_000),
  })
  .strict();
export type InstallConfig = z.infer<typeof InstallConfig>;

// ---------------------------------------------------------------------------
// Codemod registry entry
// ---------------------------------------------------------------------------

export const CodemodRunner = z.enum(['npx', 'uvx']);
export type CodemodRunner = z.infer<typeof CodemodRunner>;

export const CodemodEntry = z
  .object({
    id: z.string().min(1),
    runner: CodemodRunner,
    package: z.string().min(1),
    /** Exact pinned version — no ranges, no `latest`. */
    version: z.string().regex(/^\d+\.\d+\.\d+/, 'must be an exact semver'),
    /** argv template. `{sandbox}` is replaced with the sandbox root path. */
    argv_template: z.array(z.string().min(1)).min(1),
    languages: z.array(z.enum(['ts', 'js', 'tsx', 'jsx', 'py'])).min(1),
  })
  .strict();
export type CodemodEntry = z.infer<typeof CodemodEntry>;

// ---------------------------------------------------------------------------
// Exec result
// ---------------------------------------------------------------------------

export const ExecResult = z
  .object({
    argv: z.array(z.string()),
    exit_code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    duration_ms: z.number().int(),
    timed_out: z.boolean(),
  })
  .strict();
export type ExecResult = z.infer<typeof ExecResult>;

// ---------------------------------------------------------------------------
// Check result
// ---------------------------------------------------------------------------

export const CheckStatus = z.enum(['pass', 'fail', 'baseline_failing', 'flaky', 'timeout']);
export type CheckStatus = z.infer<typeof CheckStatus>;

/** Parsed per-test results from a JUnit XML report the user's runner wrote. */
export const JUnitSummary = z
  .object({
    tests: z.number().int(),
    failures: z.number().int(),
    errors: z.number().int(),
    skipped: z.number().int(),
    /** Names of failing or errored test cases, for the agent's report. */
    failing: z.array(z.string()),
  })
  .strict();
export type JUnitSummary = z.infer<typeof JUnitSummary>;

export const CheckResult = z
  .object({
    name: z.string(),
    status: CheckStatus,
    exit_code: z.number().int().nullable(),
    output_tail: z.string(),
    duration_ms: z.number().int(),
    /** Per-test results when the check declared a JUnit path and it was written. */
    junit: JUnitSummary.nullable().optional(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResult>;

// ---------------------------------------------------------------------------
// Codemod run result
// ---------------------------------------------------------------------------

export const CodemodStatus = z.enum(['ok', 'codemod_unavailable', 'failed']);
export type CodemodStatus = z.infer<typeof CodemodStatus>;

export const CodemodResult = z
  .object({
    id: z.string(),
    status: CodemodStatus,
    diff: z.string(),
    duration_ms: z.number().int(),
  })
  .strict();
export type CodemodResult = z.infer<typeof CodemodResult>;

// ---------------------------------------------------------------------------
// Gate 7 result
// ---------------------------------------------------------------------------

export const Gate7Rule = z.enum([
  'deleted_test_file',
  'fewer_test_cases',
  'fewer_assertions',
  'new_skip_marker',
  'deleted_snapshot',
  'lowered_coverage_threshold',
  'changed_check_definition',
]);
export type Gate7Rule = z.infer<typeof Gate7Rule>;

export const Gate7Result = z
  .object({
    pass: z.boolean(),
    violations: z.array(
      z
        .object({
          rule: Gate7Rule,
          file: z.string(),
          detail: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type Gate7Result = z.infer<typeof Gate7Result>;

// ---------------------------------------------------------------------------
// Stage decision
// ---------------------------------------------------------------------------

export const StageDecision = z.enum(['kept', 'rejected', 'unresolved', 'skipped']);
export type StageDecision = z.infer<typeof StageDecision>;

export const StageAttempt = z
  .object({
    run_id: z.string(),
    stage_id: z.string(),
    attempt: z.number().int(),
    codemods: z.array(CodemodResult),
    patch_hash: z.string().nullable(),
    checks: z.array(CheckResult),
    gate7: Gate7Result,
    decision: StageDecision,
  })
  .strict();
export type StageAttempt = z.infer<typeof StageAttempt>;

// ---------------------------------------------------------------------------
// Tool I/O
// ---------------------------------------------------------------------------

export const VerifyStageInput = z
  .object({
    run_id: z.string().min(1),
    stage_id: z.string().min(1),
  })
  .strict();
export type VerifyStageInput = z.infer<typeof VerifyStageInput>;

export const VerifyStageOutput = z
  .object({
    run_id: z.string(),
    stage_id: z.string(),
    attempt: z.number().int(),
    /** Unified diff of codemod changes (empty string if none). */
    codemod_diff: z.string(),
    /** Findings that still need a manual patch after codemods. */
    remaining_findings: z.array(z.string()),
    codemods: z.array(CodemodResult),
  })
  .strict();
export type VerifyStageOutput = z.infer<typeof VerifyStageOutput>;

export const PatchEntry = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type PatchEntry = z.infer<typeof PatchEntry>;

export const SubmitStagePatchInput = z
  .object({
    run_id: z.string().min(1),
    stage_id: z.string().min(1),
    /** A unified diff string, or a list of {path, content} entries. Exactly one must be provided. */
    patch: z.union([z.string(), z.array(PatchEntry)]),
    tokens: ReportedTokens.optional().describe('Tokens this patch turn used, if the host reports them. Counted toward the run budget.'),
  })
  .strict();
export type SubmitStagePatchInput = z.infer<typeof SubmitStagePatchInput>;

export const SubmitStagePatchOutput = z
  .object({
    run_id: z.string(),
    stage_id: z.string(),
    attempt: z.number().int(),
    decision: StageDecision,
    /** Present when decision is 'rejected' or 'unresolved': why it failed. */
    failures: z
      .array(
        z
          .object({
            check: z.string().nullable(),
            reason: z.string(),
          })
          .strict(),
      )
      .optional(),
    /** Path to the exported patch file (relative to out dir), when kept. */
    patch_path: z.string().optional(),
  })
  .strict();
export type SubmitStagePatchOutput = z.infer<typeof SubmitStagePatchOutput>;

export const GetVerifyReportInput = z
  .object({
    run_id: z.string().min(1),
  })
  .strict();
export type GetVerifyReportInput = z.infer<typeof GetVerifyReportInput>;

export const VerifyReport = z
  .object({
    run_id: z.string(),
    sandbox_path: z.string().nullable(),
    source_head: z.string().nullable(),
    baseline_checks: z.array(CheckResult),
    stages: z.array(
      z
        .object({
          stage_id: z.string(),
          title: z.string(),
          decision: StageDecision.nullable(),
          attempts: z.array(StageAttempt),
          patch_path: z.string().nullable(),
        })
        .strict(),
    ),
    /** The git apply command the user runs to apply all kept patches. */
    apply_command: z.string().nullable(),
  })
  .strict();
export type VerifyReport = z.infer<typeof VerifyReport>;

export const GetVerifyReportOutput = z
  .object({
    run_id: z.string(),
    report: VerifyReport,
  })
  .strict();
export type GetVerifyReportOutput = z.infer<typeof GetVerifyReportOutput>;
