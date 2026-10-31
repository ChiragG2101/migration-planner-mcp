// submit_stage_patch (M8): apply the agent's patch, run checks and gate 7, and
// decide kept / rejected / unresolved. On kept, the stage is committed in the
// sandbox and the patch (stage start → commit) is exported under
// <out>/<run_id>/patches/. After the retry cap the stage goes to unresolved and
// the sandbox is reset to the stage start. A gate-7 reduction that is otherwise
// clean is held for human review under patches/needs-review/.
import path from 'node:path';
import { z } from 'zod';
import type { Finding } from '../schema/finding.js';
import { SubmitStagePatchInput, type SubmitStagePatchOutput, type StageDecision } from '../schema/verify.js';
import { InputError } from '../security/errors.js';
import { assertLevel } from '../security/level.js';
import { realpathAbs } from '../security/pathBoundary.js';
import { writeFileSandbox, mkdirSandbox } from '../security/safeWrite.js';
import { getPlan } from '../store/plans.js';
import { getSandbox, listBaselineChecks, putStageAttempt, listStageAttempts, parseCodemods } from '../store/verify.js';
import { snapshotTests } from '../verify/testIntegrity.js';
import { applyPatch, evaluateStage } from '../verify/loop.js';
import { openSandbox, resetToStageStart, stageStartTag } from '../verify/sandbox.js';
import { execGit } from '../security/exec.js';
import { sandboxCommitEnv } from '../verify/sandbox.js';
import { runTool, withExecLog, type Engine } from './engine.js';
import { heldForReview } from '../pipeline/routing.js';
import { openRunPack } from './packRun.js';

/** Attempts allowed per stage before it goes to unresolved (plan task 6). */
export const RETRY_CAP = 3;

export async function submitStagePatch(engine: Engine, raw: unknown): Promise<SubmitStagePatchOutput> {
  assertLevel(1);
  const parsed = SubmitStagePatchInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));

  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'submit_stage_patch', parsed.data, async (call) => {
    call.attachRun(opened.run.id);
    if (parsed.data.tokens) call.cost(parsed.data.tokens.in, parsed.data.tokens.out);
    return withExecLog(call, async () => {
      const db = opened.session.db;
      const runId = opened.run.id;
      const stageId = parsed.data.stage_id;

      const storedPlan = getPlan(db, runId);
      if (!storedPlan) throw new InputError('no_plan', `run ${runId} has no plan`);
      const plan = storedPlan.plan as unknown as {
        stages: Array<{ id: string; finding_ids: string[]; title: string }>;
        findings: Finding[];
      };

      const stage = plan.stages.find((s) => s.id === stageId);
      if (!stage) throw new InputError('unknown_stage', `stage ${stageId} not found in plan`);

      const sandboxRow = getSandbox(db, runId);
      if (!sandboxRow) throw new InputError('no_sandbox', `no sandbox for run ${runId}; call verify_stage first`);

      const sandboxHandle = openSandbox(realpathAbs(sandboxRow.path), sandboxRow.source_head);

      const checks = engine.options.checks ?? [];
      const baselineRows = listBaselineChecks(db, runId);
      const baselineFailingNames = new Set(
        baselineRows.filter((r) => r.status === 'baseline_failing').map((r) => r.check_name),
      );

      const prevAttempts = listStageAttempts(db, runId, stageId);
      // A stage already decided kept or unresolved cannot be patched again.
      const settled = prevAttempts.find((a) => a.decision === 'kept' || a.decision === 'unresolved');
      if (settled) {
        throw new InputError('stage_settled', `stage ${stageId} is already ${settled.decision}`);
      }
      const attempt = prevAttempts.length + 1;

      // Snapshot the test state at the stage start (before this patch) for gate 7.
      const beforeSnapshot = await snapshotTests(sandboxHandle.root);

      // Apply the patch. A failure (bad path, apply conflict) is a rejected attempt.
      let patchDiff: string;
      try {
        patchDiff = applyPatch(sandboxHandle, parsed.data.patch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resetToStageStart(sandboxHandle, stageId);
        return recordAndReturn(db, call, {
          runId, stageId, attempt,
          codemodsJson: '[]', patchHash: null, checksJson: '[]',
          gate7Json: JSON.stringify({ pass: false, violations: [] }),
          decision: capDecision('rejected', attempt),
          failures: [{ check: null, reason: `patch apply failed: ${msg}` }],
        });
      }

      const lastCodemods = prevAttempts.length > 0
        ? parseCodemods(prevAttempts[prevAttempts.length - 1]!.codemods_json)
        : [];

      const result = await evaluateStage(
        sandboxHandle, beforeSnapshot, checks, baselineFailingNames, lastCodemods, patchDiff, attempt,
        engine.options.passEnv,
      );

      // A gate-7 reduction with otherwise-clean checks is held for review, not kept.
      const needsReview = heldForReview(result.checks, result.gate7);

      let decision: StageDecision = result.decision;
      let patchPath: string | undefined;

      if (decision === 'kept') {
        // Commit the stage in the sandbox and export the patch (stage start → commit).
        commitStage(sandboxHandle, stageId);
        const diff = execGit(
          ['git', 'diff', `${stageStartTag(stageId)}`, 'HEAD'],
          sandboxHandle.rootPath, sandboxHandle.root, 30_000,
        ).stdout;
        patchPath = exportPatch(engine, opened.session.outDir, runId, stage, diff, 'kept');
      } else {
        // Rejected. If we've hit the cap, the stage is unresolved; else reset for a retry.
        decision = capDecision('rejected', attempt);
        if (needsReview) {
          patchPath = exportPatch(engine, opened.session.outDir, runId, stage, patchDiff, 'needs-review');
        }
        resetToStageStart(sandboxHandle, stageId);
      }

      const failures = decision !== 'kept'
        ? [
            ...result.checks
              .filter((c) => c.status === 'fail' || c.status === 'timeout')
              .map((c) => ({ check: c.name, reason: `${c.status} (exit ${c.exit_code ?? '?'})` })),
            ...result.gate7.violations.map((v) => ({ check: null, reason: `gate7 ${v.rule}: ${v.detail}` })),
          ]
        : undefined;

      return recordAndReturn(db, call, {
        runId, stageId, attempt,
        codemodsJson: JSON.stringify(result.codemods),
        patchHash: result.patchHash,
        checksJson: JSON.stringify(result.checks),
        gate7Json: JSON.stringify(result.gate7),
        decision,
        failures,
        patchPath,
        needsReview,
      });
    });
  });
}

/** After RETRY_CAP rejected attempts, a stage becomes unresolved. */
export function capDecision(base: StageDecision, attempt: number): StageDecision {
  if (base === 'rejected' && attempt >= RETRY_CAP) return 'unresolved';
  return base;
}

function commitStage(sandbox: ReturnType<typeof openSandbox>, stageId: string): void {
  execGit(['git', 'add', '-A'], sandbox.rootPath, sandbox.root, 30_000);
  // Fixed identity via env so no user .gitconfig is read.
  execGit(
    ['git', 'commit', '--no-verify', '-m', `migration stage ${stageId}`],
    sandbox.rootPath, sandbox.root, 30_000, sandboxCommitEnv(),
  );
}

function exportPatch(
  engine: Engine,
  outDir: string,
  runId: string,
  stage: { id: string },
  diff: string,
  kind: 'kept' | 'needs-review',
): string {
  // Zero-padded stage index keeps patches/ in apply order.
  const name = `${stage.id}.patch`;
  const rel = kind === 'kept'
    ? path.join(runId, 'patches', name)
    : path.join(runId, 'patches', 'needs-review', name);
  const abs = path.join(outDir, rel);
  mkdirSandbox(path.dirname(abs));
  writeFileSandbox(abs, diff);
  void engine;
  return rel;
}

interface RecordArgs {
  runId: string;
  stageId: string;
  attempt: number;
  codemodsJson: string;
  patchHash: string | null;
  checksJson: string;
  gate7Json: string;
  decision: StageDecision;
  failures?: Array<{ check: string | null; reason: string }>;
  patchPath?: string;
  needsReview?: boolean;
}

function recordAndReturn(
  db: Parameters<typeof putStageAttempt>[0],
  call: { event: (name: string, data: Record<string, unknown>) => void },
  a: RecordArgs,
): SubmitStagePatchOutput {
  putStageAttempt(db, {
    run_id: a.runId,
    stage_id: a.stageId,
    attempt: a.attempt,
    codemods_json: a.codemodsJson,
    patch_hash: a.patchHash,
    checks_json: a.checksJson,
    gate7_json: a.gate7Json,
    decision: a.decision,
  });
  // The whole attempt goes into the event, so the run report is rebuilt from events alone (M9).
  call.event('submit_stage_patch.result', {
    stage_id: a.stageId,
    attempt: a.attempt,
    decision: a.decision,
    codemods: JSON.parse(a.codemodsJson) as unknown,
    patch_hash: a.patchHash,
    checks: JSON.parse(a.checksJson) as unknown,
    gate7: JSON.parse(a.gate7Json) as unknown,
    needs_review: a.needsReview ?? false,
    patch_path: a.patchPath ?? null,
    failures: a.failures ?? [],
  });
  return {
    run_id: a.runId,
    stage_id: a.stageId,
    attempt: a.attempt,
    decision: a.decision,
    ...(a.failures ? { failures: a.failures } : {}),
    ...(a.patchPath ? { patch_path: a.patchPath } : {}),
  };
}
