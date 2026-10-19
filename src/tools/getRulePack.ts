import { getRulePack, GetRulePackInput } from '../core/index.js';
import { GetRulePackOutput } from '../schema/rulePack.js';
import type { ToolDef } from './index.js';

export const getRulePackTool: ToolDef = {
  name: 'get_rule_pack',
  title: 'Get rule pack',
  description:
    'The composed rules for an upgrade range, with necessity and lands_on derived, the codemods and which rules they cover, ' +
    'and the reference file paths. Pass a run_id, or a source and target. Read-only.',
  inputSchema: GetRulePackInput,
  outputSchema: GetRulePackOutput,
  handler: (engine, input) => getRulePack(engine, input),
};
