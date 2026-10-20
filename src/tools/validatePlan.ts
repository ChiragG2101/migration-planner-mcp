import { validatePlan, ValidatePlanInput } from '../core/index.js';
import { ValidatePlanOutput } from '../schema/plan.js';
import type { ToolDef } from './index.js';

export const validatePlanTool: ToolDef = {
  name: 'validate_plan',
  title: 'Validate the plan against the six gates',
  description:
    'Runs the six deterministic gates on the stored plan and returns a per-finding pass or fail with exact reasons. ' +
    'Increments the round; after 3 rounds, failures move to unresolved and the plan is never marked passed. No model, no network.',
  inputSchema: ValidatePlanInput,
  outputSchema: ValidatePlanOutput,
  handler: (engine, input) => validatePlan(engine, input),
};
