// Feedback entries on a run (M9, migration 008). One row per entry, numbered
// from 1 within the run.
import type { FeedbackKind } from '../schema/feedback.js';
import type { Db } from './db.js';

export interface FeedbackRow {
  run_id: string;
  n: number;
  kind: FeedbackKind;
  finding_id: string | null;
  stage_id: string | null;
  note: string;
  file: string | null;
  line: number | null;
  created_at: string;
  export_path: string;
}

/** The next entry number for a run. */
export function nextFeedbackN(db: Db, runId: string): number {
  const row = db.prepare('SELECT MAX(n) AS n FROM feedback WHERE run_id = ?').get(runId) as { n: number | null };
  return (row.n ?? 0) + 1;
}

export function putFeedback(db: Db, row: FeedbackRow): void {
  db.prepare(
    `INSERT INTO feedback (run_id, n, kind, finding_id, stage_id, note, file, line, created_at, export_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.run_id, row.n, row.kind, row.finding_id, row.stage_id, row.note, row.file, row.line, row.created_at, row.export_path);
}

export function listFeedback(db: Db, runId: string): FeedbackRow[] {
  return db.prepare('SELECT * FROM feedback WHERE run_id = ? ORDER BY n').all(runId) as unknown as FeedbackRow[];
}
