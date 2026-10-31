// verify_stage (M8): create the sandbox (first call), run codemods for the
// stage, and return the diff + remaining findings for the agent to patch.
import { z } from 'zod';
import type { Finding } from '../schema/finding.js';
import { VerifyStageInput, type VerifyStageOutput } from '../schema/verify.js';
import { newCuts } from '../pipeline/budget.js';
import { InputError } from '../security/errors.js';
import { assertLevel } from '../security/level.js';
import { realpathAbs } from '../security/pathBoundary.js';
import { repoRoot } from '../store/campaigns.js';
import { listEvents } from '../store/events.js';
import { getPlan } from '../store/plans.js';
import { putSandbox, getSandbox, putBaselineCheck, listStageAttempts, latestStageAttempt } from '../store/verify.js';
import { createSandbox, openSandbox, tagStageStart } from '../verify/sandbox.js';
import { runInstall, runChecks, prepareStage } from '../verify/loop.js';
import { runTool, withExecLog, type Engine } from './engine.js';
import { openRunPack } from './packRun.js';

export async function verifyStage(engine: Engine, raw: unknown): Promise<VerifyStageOutput> {
  assertLevel(1);
  const parsed = VerifyStageInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));

  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'verify_stage', parsed.data, async (call) => {
    call.attachRun(opened.run.id);
    return withExecLog(call, async () => {
      const db = opened.session.db;
      const runId = opened.run.id;
      const stageId = parsed.data.stage_id;

      // Require a plan.
      const storedPlan = getPlan(db, runId);
      if (!storedPlan) throw new InputError('no_plan', `run ${runId} has no plan; call merge_findings first`);
      const plan = storedPlan.plan as unknown as { stages: Array<{ id: string; finding_ids: string[]; title: string }>; findings: Finding[] };

      const stageIndex = plan.stages.findIndex((s) => s.id === stageId);
      if (stageIndex < 0) throw new InputError('unknown_stage', `stage ${stageId} not found in plan`);
      const stage = plan.stages[stageIndex]!;

      // Precondition: the plan must be validated on its latest round (D) — a draft
      // or failed plan is not ready to verify.
      if (storedPlan.status !== 'passed' && storedPlan.status !== 'capped') {
        throw new InputError('plan_not_validated', `plan is '${storedPlan.status}'; run validate_plan until it passes before verifying`);
      }

      // Precondition: this stage must not already be settled (kept/unresolved).
      const settled = latestStageAttempt(db, runId, stageId);
      if (settled && (settled.decision === 'kept' || settled.decision === 'unresolved')) {
        throw new InputError('stage_settled', `stage ${stageId} is already ${settled.decision}`);
      }

      // Over budget: every stage not settled yet is cut (recorded once each) and no new stage starts (M9 task 5).
      const unsettled = plan.stages.filter((s) => {
        const dec = latestStageAttempt(db, runId, s.id)?.decision;
        return dec !== 'kept' && dec !== 'unresolved' && dec !== 'skipped';
      });
      const over = newCuts(engine.options.budget, listEvents(db, runId), engine.now(), unsettled.map((s) => ({ what: 'stage' as const, id: s.id })));
      if (over.reason) {
        for (const cut of over.cuts) call.event('budget.cut', cut);
        throw new InputError('budget_cut', `the run is over budget (${over.reason}); stages not verified yet are recorded as budget_cut`);
      }

      // Precondition: every earlier stage must be kept or explicitly skipped.
      // Stages after a skipped one are flagged built_on_skip in the report.
      let builtOnSkip = false;
      for (let i = 0; i < stageIndex; i++) {
        const prior = plan.stages[i]!;
        const dec = latestStageAttempt(db, runId, prior.id)?.decision;
        if (dec === 'skipped') builtOnSkip = true;
        else if (dec !== 'kept') {
          throw new InputError('out_of_order', `stage ${prior.id} is not kept yet; verify stages in order`);
        }
      }

      const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
      if (!root) throw new InputError('unknown_run', `run ${runId} has no repo`);

      const checks = engine.options.checks ?? [];
      const installs = engine.options.installs ?? [];
      const passEnv = engine.options.passEnv;

      // Create sandbox on first call.
      const sandboxRow = getSandbox(db, runId);
      let sandboxRoot: string;
      if (!sandboxRow) {
        const sandbox = createSandbox(root, opened.session.outDir, runId);
        // Run install commands.
        if (installs.length > 0) runInstall(sandbox, installs, passEnv);
        // Run baseline checks (no flaky rerun at baseline).
        const baselineChecks = runChecks(sandbox, checks, new Set(), false, passEnv);
        for (const c of baselineChecks) {
          putBaselineCheck(db, {
            run_id: runId,
            check_name: c.name,
            status: c.status === 'pass' ? 'pass' : 'baseline_failing',
            exit_code: c.exit_code,
            output: c.output_tail,
            junit_json: c.junit ? JSON.stringify(c.junit) : null,
          });
        }
        // A run where every check fails at baseline cannot judge new failures, so
        // it stops instead of verifying anything (plan task 4).
        if (checks.length > 0 && baselineChecks.every((c) => c.status !== 'pass')) {
          throw new InputError(
            'baseline_all_failing',
            `every check fails on the unmodified sandbox; fix the checks or the environment before verifying (${baselineChecks.map((c) => c.name).join(', ')})`,
          );
        }
        putSandbox(db, {
          run_id: runId,
          path: sandbox.root,
          source_head: sandbox.sourceHead,
          created_at: engine.now().toISOString(),
        });
        sandboxRoot = sandbox.root;
        call.event('sandbox.created', { path: sandbox.root, source_head: sandbox.sourceHead });
      } else {
        sandboxRoot = sandboxRow.path;
      }

      // Reconstruct the sandbox handle (no new clone) and tag the stage start so
      // a rollback (or the next attempt) returns to exactly this tree.
      const sandboxHandle = openSandbox(realpathAbs(sandboxRoot), sandboxRow?.source_head ?? '');
      tagStageStart(sandboxHandle, stageId);

      // Get findings for this stage.
      const stageFindingIds = new Set(stage.finding_ids);
      const stageFindings = plan.findings.filter((f) => stageFindingIds.has(f.id));

      // Run codemods.
      const { codemods, codemodDiff, remainingFindings } = prepareStage(sandboxHandle, stageFindings);

      call.event('verify_stage.codemods', {
        stage_id: stageId,
        codemods: codemods.length,
        remaining: remainingFindings.length,
        built_on_skip: builtOnSkip,
      });

      // Count existing attempts.
      const attempts = listStageAttempts(db, runId, stageId);
      const attempt = attempts.length + 1;

      return {
        run_id: runId,
        stage_id: stageId,
        attempt,
        codemod_diff: codemodDiff,
        remaining_findings: remainingFindings,
        codemods,
      };
    });
  });
}
