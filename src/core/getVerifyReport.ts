// get_verify_report (M8): return the full verify loop state for a run.
// buildVerifyReport is shared with emit_plan, which writes verify_report.json.
import path from 'node:path';
import { z } from 'zod';
import type { Finding } from '../schema/finding.js';
import { GetVerifyReportInput, type GetVerifyReportOutput, type VerifyReport } from '../schema/verify.js';
import { InputError } from '../security/errors.js';
import { getPlan } from '../store/plans.js';
import { getSandbox, listBaselineChecks, listStageAttempts, parseChecks, parseCodemods, parseGate7 } from '../store/verify.js';
import type { Db } from '../store/db.js';
import { runTool, type Engine } from './engine.js';
import { openRunPack } from './packRun.js';

export async function getVerifyReport(engine: Engine, raw: unknown): Promise<GetVerifyReportOutput> {
  const parsed = GetVerifyReportInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));

  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'get_verify_report', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const report = buildVerifyReport(opened.session.db, opened.run.id, opened.session.outDir);
    return Promise.resolve({ run_id: opened.run.id, report });
  });
}

/**
 * The verify loop state for a run, from the store. get_verify_report returns
 * it, and emit_plan writes it to verify_report.json when L1 ran (M9).
 */
export function buildVerifyReport(db: Db, runId: string, outDir: string): VerifyReport {
  const sandboxRow = getSandbox(db, runId);
  const baselineRows = listBaselineChecks(db, runId);
  const storedPlan = getPlan(db, runId);

  const baselineChecks = baselineRows.map((r) => ({
    name: r.check_name,
    status: r.status as 'pass' | 'fail' | 'baseline_failing',
    exit_code: r.exit_code,
    output_tail: r.output ?? '',
    duration_ms: 0,
  }));

  let stages: VerifyReport['stages'] = [];
  let applyCommand: string | null = null;

  if (storedPlan) {
    const plan = storedPlan.plan as unknown as {
      stages: Array<{ id: string; title: string; finding_ids: string[] }>;
      findings: Finding[];
    };

    const keptPatches: string[] = [];

    stages = plan.stages.map((s) => {
      const attempts = listStageAttempts(db, runId, s.id).map((row) => ({
        run_id: runId,
        stage_id: s.id,
        attempt: row.attempt,
        codemods: parseCodemods(row.codemods_json),
        patch_hash: row.patch_hash,
        checks: parseChecks(row.checks_json),
        gate7: parseGate7(row.gate7_json),
        decision: row.decision,
      }));

      const lastKept = [...attempts].reverse().find((a) => a.decision === 'kept');
      const patchPath = lastKept ? path.join(runId, 'patches', `${s.id}.patch`) : null;
      if (patchPath) keptPatches.push(patchPath);

      const lastDecision = attempts.length > 0 ? attempts[attempts.length - 1]!.decision : null;

      return {
        stage_id: s.id,
        title: s.title,
        decision: lastDecision,
        attempts,
        patch_path: patchPath,
      };
    });

    if (keptPatches.length > 0) {
      applyCommand = `git apply ${keptPatches.map((p) => path.join(outDir, p)).join(' ')}`;
    }
  }

  const report: VerifyReport = {
    run_id: runId,
    sandbox_path: sandboxRow?.path ?? null,
    source_head: sandboxRow?.source_head ?? null,
    baseline_checks: baselineChecks,
    stages,
    apply_command: applyCommand,
  };
  return report;
}
