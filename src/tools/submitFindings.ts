import { submitFindings, SubmitFindingsInput } from '../core/index.js';
import { SubmitFindingsOutput } from '../schema/finding.js';
import type { ToolDef } from './index.js';

export const submitFindingsTool: ToolDef = {
  name: 'submit_findings',
  title: 'Submit lens findings',
  description:
    'Stores one lens\'s findings and out-of-scope marks after schema checks. ' +
    'Invalid output is returned with the errors and may be retried once; a second invalid submission records a gap. ' +
    'Does not write the repo.',
  inputSchema: SubmitFindingsInput,
  outputSchema: SubmitFindingsOutput,
  handler: (engine, input) => submitFindings(engine, input),
};
