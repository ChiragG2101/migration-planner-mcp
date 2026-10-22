// The finding, the unit a lens submits (PRD section 5, M5). Gate 4 (M6)
// requires rollback and verify for high and above; the schema leaves rollback
// optional. `stage` is assigned when the plan is built (M6), so a stored
// finding has none.
import { z } from 'zod';
import { CodemodId, RuleId, Severity } from './knowledge.js';

export const Concern = z.enum(['api_change', 'behavior_change', 'dependency', 'config', 'test', 'build', 'docs']);
export type Concern = z.infer<typeof Concern>;

export const StepKind = z.enum(['codemod', 'manual']);
export type StepKind = z.infer<typeof StepKind>;

export const FindingSource = z.enum(['rule_pack', 'usage_scan', 'codemod', 'agent_judgment']);
export type FindingSource = z.infer<typeof FindingSource>;

export const DocsStatus = z.enum(['verified', 'unverified']);
export type DocsStatus = z.infer<typeof DocsStatus>;

/** The four pack lenses, plus `combined` for a small run. */
export const FindingLens = z.enum(['api', 'dependency_build', 'behavior_runtime', 'verification', 'combined']);
export type FindingLens = z.infer<typeof FindingLens>;

export const SEPARATE_LENSES = ['api', 'dependency_build', 'behavior_runtime', 'verification'] as const satisfies readonly FindingLens[];

export const Evidence = z
  .object({
    repo_id: z.string().min(1),
    file: z.string().min(1),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    snippet_hash: z.string().regex(/^[a-f0-9]{64}$/, 'a sha256 hex digest'),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

export const DocRef = z
  .object({
    library: z.string().min(1),
    version: z.string().min(1),
    url: z.string().min(1),
    doc_id: z.string().min(1),
  })
  .strict();
export type DocRef = z.infer<typeof DocRef>;

export const Finding = z
  .object({
    id: z.string().trim().min(1).max(200),
    repo_id: z.string().min(1),
    lens: FindingLens,
    concern: Concern,
    severity: Severity,
    evidence: z.array(Evidence),
    doc_refs: z.array(DocRef),
    reasoning: z.string().trim().min(1).max(4000),
    action: z.string().trim().min(1).max(4000),
    step_kind: StepKind,
    codemod: CodemodId.optional(),
    rollback: z.string().trim().min(1).max(2000).optional(),
    verify: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    source: FindingSource,
    rule_id: RuleId.optional(),
    usage_ids: z.array(z.string().min(1)),
    docs_status: DocsStatus,
    prompt_version: z.string().trim().min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    f.evidence.forEach((e, i) => {
      if (e.repo_id !== f.repo_id) {
        ctx.addIssue({ code: 'custom', path: ['evidence', i, 'repo_id'], message: `evidence repo_id ${e.repo_id} does not match the finding repo_id ${f.repo_id}` });
      }
      if (e.line_end < e.line_start) {
        ctx.addIssue({ code: 'custom', path: ['evidence', i, 'line_end'], message: 'line_end is before line_start' });
      }
    });
    if (f.source === 'agent_judgment' && f.evidence.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'agent_judgment requires evidence' });
    }
    if (f.step_kind === 'manual' && f.codemod !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['codemod'], message: 'a manual step has no codemod' });
    }
    if (f.step_kind === 'codemod') {
      if (f.codemod === undefined) ctx.addIssue({ code: 'custom', path: ['codemod'], message: 'a codemod step names a codemod ID' });
      if (f.rule_id === undefined) ctx.addIssue({ code: 'custom', path: ['rule_id'], message: 'a codemod step names the rule whose library lists the codemod' });
      if (f.usage_ids.length === 0) ctx.addIssue({ code: 'custom', path: ['usage_ids'], message: 'a codemod step lists the usages it is expected to change' });
    }
  });
export type Finding = z.infer<typeof Finding>;

export interface FieldError {
  path: string;
  message: string;
}

export function fieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export interface FindingContext {
  /** The run's single repo. A different finding or evidence repo_id is a schema error (C10). */
  repoId: string;
  /**
   * Codemod IDs listed by the rule's library (`library.json`). `undefined`
   * means the rule is not in this run. Ignored unless `step_kind` is `codemod`.
   */
  codemodsFor: (ruleId: string) => readonly string[] | undefined;
}

/** Parses one finding. A codemod ID the rule's library does not list is rejected here. */
export function parseFinding(raw: unknown, ctx: FindingContext): { ok: true; finding: Finding } | { ok: false; errors: FieldError[] } {
  const parsed = Finding.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const finding = parsed.data;
  const errors: FieldError[] = [];
  if (finding.repo_id !== ctx.repoId) {
    errors.push({ path: 'repo_id', message: `repo_id ${finding.repo_id} does not match the run repo_id ${ctx.repoId}` });
  }
  if (finding.step_kind === 'codemod' && finding.codemod !== undefined && finding.rule_id !== undefined) {
    const listed = ctx.codemodsFor(finding.rule_id);
    if (listed === undefined) errors.push({ path: 'rule_id', message: `rule ${finding.rule_id} is not in this run` });
    else if (!listed.includes(finding.codemod)) {
      errors.push({ path: 'codemod', message: `codemod ${finding.codemod} is not listed by the rule's library` });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, finding };
}

/** Tokens the host spent on a step, when it reports them. Counted toward --budget-tokens and shown per step in the run report (M9). */
export const ReportedTokens = z
  .object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
  })
  .strict();
export type ReportedTokens = z.infer<typeof ReportedTokens>;

export const SubmitFindingsInput = z
  .object({
    run_id: z.string().min(1),
    lens: FindingLens,
    findings: z.array(z.unknown()),
    out_of_scope: z.array(z.object({ usage_id: z.string(), reason: z.string() }).strict()),
    tokens: ReportedTokens.optional().describe('Tokens this lens turn used, if the host reports them. Counted toward the run budget.'),
  })
  .strict();
export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInput>;

export const EvidenceFlag = z
  .object({
    finding_id: z.string(),
    file: z.string(),
    line_start: z.number().int(),
    line_end: z.number().int(),
    /** False when the recomputed snippet hash differs, or the lines could not be read. Gate 1 checks again (M6). */
    match: z.boolean(),
  })
  .strict();
export type EvidenceFlag = z.infer<typeof EvidenceFlag>;

export const SubmitFindingsOutput = z
  .object({
    run_id: z.string(),
    lens: FindingLens,
    accepted: z.boolean(),
    /** True when this invalid submission may be retried once. */
    retry: z.boolean(),
    /** True when this submission was the second invalid one and a lens.gap was recorded. */
    gap: z.boolean(),
    errors: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
    stored: z.number().int(),
    out_of_scope: z.number().int(),
    evidence_flags: z.array(EvidenceFlag),
  })
  .strict();
export type SubmitFindingsOutput = z.infer<typeof SubmitFindingsOutput>;
