import { getVerifyReport } from '../core/index.js';
import { GetVerifyReportInput, GetVerifyReportOutput } from '../schema/verify.js';
import type { ToolDef } from './index.js';

export const getVerifyReportToolDef: ToolDef = {
  name: 'get_verify_report',
  title: 'Get the full verify loop report for a run',
  description:
    'Returns the sandbox path, baseline check results, and per-stage attempt history ' +
    '(codemods, patch hash, check results, gate 7 results, decision). ' +
    'Also returns the git apply command to apply all kept patches to the source repo.',
  inputSchema: GetVerifyReportInput,
  outputSchema: GetVerifyReportOutput,
  handler: (engine, input) => getVerifyReport(engine, input),
};
