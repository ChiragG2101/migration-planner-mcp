import { assessRisk, AssessRiskInput } from '../core/index.js';
import { AssessRiskOutput } from '../schema/risk.js';
import type { ToolDef } from './index.js';

export const assessRiskTool: ToolDef = {
  name: 'assess_risk',
  title: 'Assess risk',
  description:
    'A suggested severity for every usage in the run, with one explanation per signal. Deterministic. ' +
    'A usage no composed rule matches is flagged unmapped. Read-only.',
  inputSchema: AssessRiskInput,
  outputSchema: AssessRiskOutput,
  handler: (engine, input) => assessRisk(engine, input),
};
