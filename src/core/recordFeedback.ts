// record_feedback (M9 task 6). Stores one feedback entry with the run and
// exports it to <out>/eval/feedback/<run_id>-<n>.json, the file
// scripts/feedback-to-case.ts turns into a seeded case or a golden-case
// annotation after a human review. No training, no network. A `missing` entry's
// file and line go through SafePath, so they cannot point outside the repo.
import { z } from 'zod';
import { FeedbackExport, RecordFeedbackInput, type RecordFeedbackOutput } from '../schema/feedback.js';
import { InputError } from '../security/errors.js';
import { resolveInside } from '../security/pathBoundary.js';
import { repoRoot } from '../store/campaigns.js';
import { nextFeedbackN, putFeedback } from '../store/feedback.js';
import { getPlan } from '../store/plans.js';
import { runTool, type Engine } from './engine.js';
import { openRunPack } from './packRun.js';

export async function recordFeedback(engine: Engine, raw: unknown): Promise<RecordFeedbackOutput> {
  const parsed = RecordFeedbackInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const input = parsed.data;
  const opened = openRunPack(engine, input.run_id);
  return runTool(engine, opened.session, 'record_feedback', input, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const runId = opened.run.id;
    const plan = getPlan(db, runId)?.plan;

    if ((input.file !== undefined || input.line !== undefined) && input.kind !== 'missing') {
      throw new InputError('invalid_input', 'file and line are only for kind missing');
    }
    if (input.line !== undefined && input.file === undefined) throw new InputError('invalid_input', 'line needs a file');
    let file: string | null = null;
    if (input.file !== undefined) {
      const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
      if (!root) throw new InputError('unknown_run', `run ${runId} has no repo`);
      // The boundary check: `..`, an absolute path outside the repo or a symlink escape throws PermissionError.
      file = resolveInside(root, input.file, opened.run.repo_id).rel;
    }
    const finding = input.finding_id === undefined ? undefined : plan?.findings.find((f) => f.id === input.finding_id);
    if (input.finding_id !== undefined && !finding) throw new InputError('unknown_finding', `finding ${input.finding_id} is not in this run's plan`);
    if (input.stage_id !== undefined && !plan?.stages.some((s) => s.id === input.stage_id)) {
      throw new InputError('unknown_stage', `stage ${input.stage_id} is not in this run's plan`);
    }

    const n = nextFeedbackN(db, runId);
    const exportPath = `eval/feedback/${runId}-${n}.json`;
    const createdAt = engine.now().toISOString();
    const exported = FeedbackExport.parse({
      format: 'migration-planner-feedback@1',
      run_id: runId,
      n,
      campaign_id: opened.run.campaign_id,
      repo_id: opened.run.repo_id,
      pack: plan?.pack ?? null,
      source: opened.versions.source,
      target: opened.versions.target,
      prompt_version: plan?.prompt_version ?? null,
      kind: input.kind,
      note: input.note,
      finding_id: input.finding_id ?? null,
      stage_id: input.stage_id ?? null,
      file,
      line: input.line ?? null,
      finding: finding
        ? {
            id: finding.id,
            severity: finding.severity,
            rule_id: finding.rule_id ?? null,
            evidence: finding.evidence.map((e) => ({ file: e.file, line_start: e.line_start, line_end: e.line_end })),
          }
        : null,
      created_at: createdAt,
    });
    // The file first, so a stored entry always has its export.
    opened.session.writer.writeFile(exportPath, `${JSON.stringify(exported, null, 2)}\n`, { level: 0 });
    putFeedback(db, {
      run_id: runId,
      n,
      kind: input.kind,
      finding_id: input.finding_id ?? null,
      stage_id: input.stage_id ?? null,
      note: input.note,
      file,
      line: input.line ?? null,
      created_at: createdAt,
      export_path: exportPath,
    });
    call.event('feedback.recorded', { n, kind: input.kind, finding_id: input.finding_id ?? null, stage_id: input.stage_id ?? null, export_path: exportPath });
    return { run_id: runId, n, kind: input.kind, export_path: exportPath };
  });
}
