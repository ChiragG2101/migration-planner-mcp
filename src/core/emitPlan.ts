// emit_plan (M6 task 4). Writes plan.json and MIGRATION_PLAN.md through
// safeWrite to <out>/<run_id>/, never into the repo. It refuses unless
// validate_plan has run on the latest round. The Markdown puts an Unresolved
// section on top when non-empty and a footer stating the repo was not modified.
import { z } from 'zod';
import { renderPlanMarkdown } from '../pipeline/emit.js';
import { EmitPlanInput, type EmitPlanOutput } from '../schema/plan.js';
import { InputError } from '../security/errors.js';
import { getPlan, latestRound } from '../store/plans.js';
import { runTool, type Engine } from './engine.js';
import { openRunPack } from './packRun.js';

export async function emitPlan(engine: Engine, raw: unknown): Promise<EmitPlanOutput> {
  const parsed = EmitPlanInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'emit_plan', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const stored = getPlan(db, opened.run.id);
    if (!stored) throw new InputError('no_plan', `run ${opened.run.id} has no plan; call merge_findings first`);
    const round = latestRound(db, opened.run.id);
    if (!round || round.round !== stored.round) {
      throw new InputError('not_validated', 'call validate_plan on the latest round before emit_plan');
    }
    const md = renderPlanMarkdown(stored.plan, { packVersion: opened.pack.pack.version, status: stored.status });
    const dir = opened.run.id;
    const json = `${dir}/plan.json`;
    const markdown = `${dir}/MIGRATION_PLAN.md`;
    opened.session.writer.writeFile(json, `${JSON.stringify(stored.plan, null, 2)}\n`, { level: 0 });
    opened.session.writer.writeFile(markdown, md, { level: 0 });
    call.event('emit.result', { round: stored.round, status: stored.status, plan_json: json, plan_md: markdown, unresolved: stored.plan.unresolved.length });
    return { run_id: opened.run.id, round: stored.round, status: stored.status, plan_json: json, plan_md: markdown, unresolved: stored.plan.unresolved.length };
  });
}
