import { emitPlan, EmitPlanInput } from '../core/index.js';
import { EmitPlanOutput } from '../schema/plan.js';
import type { ToolDef } from './index.js';

export const emitPlanTool: ToolDef = {
  name: 'emit_plan',
  title: 'Write the plan to the output folder',
  description:
    'Writes plan.json and MIGRATION_PLAN.md under <out>/<run_id>/, outside the repo. ' +
    'Refuses unless validate_plan has run on the latest round. The Markdown puts unresolved items on top.',
  inputSchema: EmitPlanInput,
  outputSchema: EmitPlanOutput,
  handler: (engine, input) => emitPlan(engine, input),
};
