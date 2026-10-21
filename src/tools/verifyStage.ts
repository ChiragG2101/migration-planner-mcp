import { verifyStage } from '../core/index.js';
import { VerifyStageInput, VerifyStageOutput } from '../schema/verify.js';
import type { ToolDef } from './index.js';

export const verifyStageToolDef: ToolDef = {
  name: 'verify_stage',
  title: 'Start verifying a plan stage (L1 only)',
  description:
    'Creates the sandbox on first call, runs install commands, runs baseline checks, then runs codemods for the stage. ' +
    'Returns the codemod diff and the list of findings that still need a manual patch. ' +
    'Requires --level 1. MCP-only tool (D46).',
  inputSchema: VerifyStageInput,
  outputSchema: VerifyStageOutput,
  handler: (engine, input) => verifyStage(engine, input),
};
