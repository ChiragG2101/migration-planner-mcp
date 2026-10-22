// emit_plan (M6 task 4, M9 tasks 1-4). Writes, through safeWrite under
// <out>/<run_id>/ and never into the repo: plan.json, MIGRATION_PLAN.md, one
// stages/<n>/CHECKLIST.md per stage, run_report.md, and verify_report.json
// when the L1 verify loop ran. It refuses unless validate_plan has run on the
// latest round. Routing runs here, after the gates, on the gated plan: it
// decides where findings are shown and never changes plan.json. The facts the
// report needs are recorded as events first, and the report is built from the
// run's events alone.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { walkRepo } from '../analysis/walk.js';
import { budgetUse } from '../pipeline/budget.js';
import { checklistPath, renderChecklist, type RoutedMark } from '../pipeline/checklists.js';
import { renderPlanMarkdown } from '../pipeline/emit.js';
import { GATES } from '../pipeline/gates/index.js';
import { buildRunReport, treeHash, type ReportFacts, type RoutingFacts } from '../pipeline/report.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, heldForReview, routePlan, type StageVerify } from '../pipeline/routing.js';
import { EmitPlanInput, type EmitPlanOutput, type Plan } from '../schema/plan.js';
import type { Usage } from '../schema/usage.js';
import { InputError } from '../security/errors.js';
import { repoRoot } from '../store/campaigns.js';
import type { Db } from '../store/db.js';
import { listEvents } from '../store/events.js';
import { getPlan, latestRound } from '../store/plans.js';
import { getScope } from '../store/scope.js';
import { getSandbox, listStageAttempts, parseChecks, parseGate7 } from '../store/verify.js';
import { allCodemodEntries } from '../verify/codemods.js';
import { runTool, ENGINE_VERSION, type Engine } from './engine.js';
import { buildVerifyReport } from './getVerifyReport.js';
import { composeRun, openRunPack, requireUsages } from './packRun.js';

/** The registry's identity: a short hash of every pinned entry, so a registry change shows in the report. */
function codemodRegistryVersion(): string {
  return createHash('sha256').update(JSON.stringify(allCodemodEntries())).digest('hex').slice(0, 12);
}

/** Per-stage L1 state from the store, or undefined when no sandbox exists for the run. */
function stageVerify(db: Db, runId: string, plan: Plan): StageVerify[] | undefined {
  if (!getSandbox(db, runId)) return undefined;
  return plan.stages.map((s) => {
    const attempts = listStageAttempts(db, runId, s.id);
    const held = attempts.flatMap((a) => {
      const gate7 = parseGate7(a.gate7_json);
      return heldForReview(parseChecks(a.checks_json), gate7) ? gate7.violations.map((v) => `${v.rule} in ${v.file}: ${v.detail}`) : [];
    });
    return { stage_id: s.id, decision: attempts.at(-1)?.decision ?? null, attempts: attempts.length, held_for_review: [...new Set(held)] };
  });
}

function coverage(plan: Plan, usages: readonly Usage[]): ReportFacts['coverage'] {
  const ids = new Set(usages.map((u) => u.id));
  const covered = new Set(plan.findings.flatMap((f) => f.usage_ids).filter((id) => ids.has(id)));
  const oos: Record<string, Record<string, number>> = {};
  const outIds = new Set<string>();
  for (const o of plan.out_of_scope) {
    const by = (oos[o.written_by] ??= {});
    by[o.reason] = (by[o.reason] ?? 0) + 1;
    outIds.add(o.usage_id);
  }
  const uncovered = [...ids].filter((id) => !covered.has(id) && !outIds.has(id)).length;
  return { found: ids.size, covered: covered.size, out_of_scope: oos, uncovered };
}

export async function emitPlan(engine: Engine, raw: unknown): Promise<EmitPlanOutput> {
  const parsed = EmitPlanInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'emit_plan', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const runId = opened.run.id;
    const stored = getPlan(db, runId);
    if (!stored) throw new InputError('no_plan', `run ${runId} has no plan; call merge_findings first`);
    const round = latestRound(db, runId);
    if (!round || round.round !== stored.round) {
      throw new InputError('not_validated', 'call validate_plan on the latest round before emit_plan');
    }
    const plan = stored.plan;
    const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
    if (!root) throw new InputError('unknown_run', `run ${runId} has no repo`);

    // Routing, after the gates (task 1).
    const loaded = requireUsages(opened.session, runId);
    const stop = getScope(db, runId)?.answers['stop_at'];
    const rulesOf = (c: ReturnType<typeof composeRun>) => c.libraries.flatMap((l) => l.rules);
    const targetRules = rulesOf(composeRun(opened.pack, opened.versions, { usages: loaded.usages }));
    const runRules = typeof stop === 'string' ? rulesOf(composeRun(opened.pack, opened.versions, { stopAt: stop, usages: loaded.usages })) : targetRules;
    const verify = stageVerify(db, runId, plan);
    const threshold = engine.options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const thresholdSource = engine.options.confidenceThreshold === undefined ? ('default' as const) : ('flag' as const);
    const routing = routePlan({ plan, threshold, usages: loaded.usages, targetRules, runRules, ...(verify ? { verify } : {}) });
    const routingFacts: RoutingFacts = {
      threshold,
      threshold_source: thresholdSource,
      review_first: routing.review_first,
      needs_human: routing.needs_human,
      main: Object.values(routing.main).reduce((n, ids) => n + ids.length, 0),
    };
    call.event('routing.result', routingFacts);

    // The verify report, when L1 ran.
    const dir = runId;
    let verifyReport: string | null = null;
    if (verify) {
      const report = buildVerifyReport(db, runId, opened.session.outDir);
      verifyReport = `${dir}/verify_report.json`;
      opened.session.writer.writeFile(verifyReport, `${JSON.stringify(report, null, 2)}\n`, { level: 0 });
      call.event('verify.report', report);
    }

    // The repo as the engine sees it now, for the "untouched" line.
    const walked = walkRepo(root, opened.run.repo_id, engine.limits);
    const afterHash = treeHash(walked.files);
    call.event('repo.hash', { phase: 'emit', hash: afterHash, files: walked.files.length });
    const beforeEvent = listEvents(db, runId).find((e) => e.kind === 'repo.hash' && (JSON.parse(e.payload_json) as { phase: string }).phase === 'scan');
    const beforeHash = beforeEvent ? (JSON.parse(beforeEvent.payload_json) as { hash: string }).hash : null;

    const gates = [...GATES.map((g) => g.id), ...(verify ? ['g7_test_integrity'] : [])];
    const facts: ReportFacts = {
      versions: { engine: ENGINE_VERSION, pack: plan.pack, pack_version: opened.pack.pack.version, prompt: plan.prompt_version, codemod_registry: codemodRegistryVersion(), gates },
      plan: {
        status: stored.status,
        round: stored.round,
        stages: plan.stages.length,
        findings: plan.findings.length,
        unresolved: plan.unresolved.length,
        l1_unresolved_stages: (verify ?? []).filter((v) => v.decision === 'unresolved').length,
      },
      coverage: coverage(plan, loaded.usages),
      budget: { limits: engine.options.budget ?? {}, used: budgetUse(listEvents(db, runId), engine.now()) },
    };
    call.event('report.facts', facts);

    const md = renderPlanMarkdown(plan, {
      packVersion: opened.pack.pack.version,
      status: stored.status,
      routing,
      thresholdSource,
      gates,
      engineVersion: ENGINE_VERSION,
      repoHash: { before: beforeHash, after: afterHash },
      ...(verify ? { verify } : {}),
    });
    const json = `${dir}/plan.json`;
    const markdown = `${dir}/MIGRATION_PLAN.md`;
    opened.session.writer.writeFile(json, `${JSON.stringify(plan, null, 2)}\n`, { level: 0 });
    opened.session.writer.writeFile(markdown, md, { level: 0 });

    // Checklists (task 3): one per stage, part of the L0 emit.
    const marks = new Map<string, RoutedMark>([
      ...routing.needs_human.map((id) => [id, 'needs human decision'] as const),
      ...routing.review_first.flatMap((r) => (r.finding_id ? [[r.finding_id, 'review first'] as const] : [])),
    ]);
    const checklists: string[] = [];
    for (const stage of [...plan.stages].sort((a, b) => a.order - b.order)) {
      const rel = checklistPath(runId, stage);
      opened.session.writer.writeFile(rel, renderChecklist(stage, plan.findings, opened.pack.pack.checks_hint, marks), { level: 0 });
      checklists.push(rel);
    }

    // The run report (task 4), from the run's events.
    const runReport = `${dir}/run_report.md`;
    opened.session.writer.writeFile(runReport, buildRunReport(runId, listEvents(db, runId)), { level: 0 });

    const summary = { threshold, threshold_source: thresholdSource, review_first: routing.review_first.length, needs_human: routing.needs_human.length };
    call.event('emit.result', { round: stored.round, status: stored.status, plan_json: json, plan_md: markdown, run_report: runReport, checklists, verify_report: verifyReport, unresolved: plan.unresolved.length });
    return {
      run_id: runId,
      round: stored.round,
      status: stored.status,
      plan_json: json,
      plan_md: markdown,
      unresolved: plan.unresolved.length,
      run_report: runReport,
      checklists,
      verify_report: verifyReport,
      routing: summary,
    };
  });
}
