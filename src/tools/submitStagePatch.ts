import { submitStagePatch } from '../core/index.js';
import { SubmitStagePatchInput, SubmitStagePatchOutput } from '../schema/verify.js';
import type { ToolDef } from './index.js';

export const submitStagePatchToolDef: ToolDef = {
  name: 'submit_stage_patch',
  title: 'Submit a patch for a stage and run checks + gate 7 (L1 only)',
  description:
    'Applies the agent patch to the sandbox, runs the declared checks, runs gate 7 (test integrity), ' +
    'and decides kept or rejected. If kept, writes the patch file and returns its path. ' +
    'If rejected, rolls back the sandbox and returns the failure reasons. ' +
    'Requires --level 1. MCP-only tool (D46).',
  inputSchema: SubmitStagePatchInput,
  outputSchema: SubmitStagePatchOutput,
  handler: (engine, input) => submitStagePatch(engine, input),
};
