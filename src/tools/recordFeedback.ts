import { recordFeedback, RecordFeedbackInput } from '../core/index.js';
import { RecordFeedbackOutput } from '../schema/feedback.js';
import type { ToolDef } from './index.js';

export const recordFeedbackTool: ToolDef = {
  name: 'record_feedback',
  title: 'Record feedback on a run',
  description:
    'Stores feedback on a finding, a stage or the whole run (wrong, missing, severity_wrong, bad_patch or other) and exports it ' +
    'to <out>/eval/feedback/<run_id>-<n>.json for a maintainer to turn into an eval case. A missing entry may name a repo file and line, ' +
    'which must be inside the repo. No training and no network; does not write the repo.',
  inputSchema: RecordFeedbackInput,
  outputSchema: RecordFeedbackOutput,
  handler: (engine, input) => recordFeedback(engine, input),
};
