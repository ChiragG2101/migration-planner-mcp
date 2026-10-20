import { mergeFindings, MergeFindingsInput } from '../core/index.js';
import { MergeFindingsOutput } from '../schema/plan.js';
import type { ToolDef } from './index.js';

export const mergeFindingsTool: ToolDef = {
  name: 'merge_findings',
  title: 'Merge lens findings into a plan',
  description:
    'Deterministically dedupes findings, resolves conflicts, stages the work via the import graph, ' +
    'flags uncovered usages, and stores the plan. Freezes the run scope. Does not write the repo.',
  inputSchema: MergeFindingsInput,
  outputSchema: MergeFindingsOutput,
  handler: (engine, input) => mergeFindings(engine, input),
};
