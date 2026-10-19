// assess_risk: one suggested severity per usage, with a reason for each signal.
import { z } from 'zod';
import { isEntrypoint, isTestFile, riskOf } from '../analysis/risk.js';
import { AssessRiskInput, type AssessRiskOutput } from '../schema/risk.js';
import { InputError } from '../security/errors.js';
import { runTool, type Engine } from './engine.js';
import { composeRun, openRunPack, requireUsages } from './packRun.js';

export async function assessRisk(engine: Engine, raw: unknown): Promise<AssessRiskOutput> {
  const parsed = AssessRiskInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'assess_risk', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const { usages, imports } = requireUsages(opened.session, opened.run.id);
    const composed = composeRun(opened.pack, opened.versions, { usages });
    const rules = composed.libraries.flatMap((l) => l.rules);
    const importers = new Map<string, Set<string>>();
    const testers = new Set<string>();
    for (const edge of imports) {
      if (!edge.to_file) continue;
      const set = importers.get(edge.to_file) ?? new Set<string>();
      set.add(edge.from_file);
      importers.set(edge.to_file, set);
      if (isTestFile(edge.from_file)) testers.add(edge.to_file);
    }
    const risks = usages.map((u) => riskOf(u, rules, { fanIn: importers.get(u.file)?.size ?? 0, tested: testers.has(u.file), entrypoint: isEntrypoint(u.file) }));
    call.event('risk.result', { usages: risks.length, unmapped: risks.filter((r) => r.unmapped).length });
    return { run_id: opened.run.id, risks };
  });
}
