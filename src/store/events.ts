import type { Db } from './db.js';

export interface NewEvent {
  runId: string | null;
  ts: string;
  step: string;
  kind: string;
  payload: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface EventRow {
  id: number;
  run_id: string | null;
  ts: string;
  step: string;
  kind: string;
  payload_json: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

export function appendEvent(db: Db, e: NewEvent): void {
  db.prepare(
    'INSERT INTO events (run_id, ts, step, kind, payload_json, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(e.runId, e.ts, e.step, e.kind, JSON.stringify(e.payload ?? null), e.tokensIn ?? null, e.tokensOut ?? null);
}

export function listEvents(db: Db, runId?: string): EventRow[] {
  const rows =
    runId === undefined
      ? db.prepare('SELECT * FROM events ORDER BY id').all()
      : db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId);
  return rows as unknown as EventRow[];
}
