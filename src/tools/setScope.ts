import { setScope, SetScopeInput } from '../core/index.js';
import { SetScopeOutput } from '../schema/scope.js';
import type { ToolDef } from './index.js';

export const setScopeTool: ToolDef = {
  name: 'set_scope',
  title: 'Set scope',
  description:
    'Records answers to the scope questions. An answer must be one of the offered options. Scope only narrows, and it freezes ' +
    'once a lens packet is fetched or merge_findings starts. Unanswered questions take their defaults.',
  inputSchema: SetScopeInput,
  outputSchema: SetScopeOutput,
  handler: (engine, input) => setScope(engine, input),
};
