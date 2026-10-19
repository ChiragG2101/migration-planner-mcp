import { proposeScope, ProposeScopeInput } from '../core/index.js';
import { ProposeScopeOutput } from '../schema/scope.js';
import type { ToolDef } from './index.js';

export const proposeScopeTool: ToolDef = {
  name: 'propose_scope',
  title: 'Propose scope',
  description:
    'The migration size (none, small or full) and the scope questions the facts support, each with fixed options and a default. ' +
    'Deterministic. Read-only.',
  inputSchema: ProposeScopeInput,
  outputSchema: ProposeScopeOutput,
  handler: (engine, input) => proposeScope(engine, input),
};
