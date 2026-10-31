import { InputError } from '../security/errors.js';
import type { RecordFeedbackOutput } from '../schema/feedback.js';

/** The record_feedback input from CLI flags; the tool's schema checks the rest. */
export function feedbackInput(runId: string, values: Record<string, unknown>): Record<string, unknown> {
  if (typeof values.kind !== 'string') throw new InputError('missing_kind', 'feedback needs --kind wrong|missing|severity_wrong|bad_patch|other');
  if (typeof values.note !== 'string') throw new InputError('missing_note', 'feedback needs --note "<text>"');
  const line = values.line === undefined ? undefined : Number(values.line);
  if (line !== undefined && !Number.isInteger(line)) throw new InputError('bad_line', '--line must be a positive integer');
  return {
    run_id: runId,
    kind: values.kind,
    note: values.note,
    ...(typeof values.finding === 'string' ? { finding_id: values.finding } : {}),
    ...(typeof values.stage === 'string' ? { stage_id: values.stage } : {}),
    ...(typeof values.file === 'string' ? { file: values.file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

export function formatFeedbackText(out: RecordFeedbackOutput): string {
  return [`run ${out.run_id}`, `feedback ${out.n} (${out.kind})`, `wrote ${out.export_path}`].join('\n');
}
