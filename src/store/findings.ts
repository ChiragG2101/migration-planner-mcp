// Stored findings, lens marks, the packet's usage IDs and the retry counter.
import type { Finding, FindingLens } from '../schema/finding.js';
import type { Db } from './db.js';

export interface StoredFinding {
  id: string;
  lens: FindingLens;
  finding: Finding;
  status: string;
  round: number;
}

export interface LensMark {
  lens: string;
  usage_id: string;
  reason: string;
  written_by: string;
}

export interface LensState {
  invalid: number;
  gap: boolean;
  accepted: boolean;
}

function tx(db: Db, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function putPacketUsages(db: Db, runId: string, lens: string, usageIds: readonly string[]): void {
  db.prepare(
    `INSERT INTO lens_packets (run_id, lens, usage_ids_json) VALUES (?, ?, ?)
     ON CONFLICT(run_id, lens) DO UPDATE SET usage_ids_json = excluded.usage_ids_json`,
  ).run(runId, lens, JSON.stringify(usageIds));
}

export function packetUsageIds(db: Db, runId: string, lens: string): string[] | undefined {
  const row = db.prepare('SELECT usage_ids_json FROM lens_packets WHERE run_id = ? AND lens = ?').get(runId, lens) as
    | { usage_ids_json: string }
    | undefined;
  return row ? (JSON.parse(row.usage_ids_json) as string[]) : undefined;
}

export function lensState(db: Db, runId: string, lens: string): LensState {
  const row = db.prepare('SELECT invalid, gap, accepted FROM lens_state WHERE run_id = ? AND lens = ?').get(runId, lens) as
    | { invalid: number; gap: number; accepted: number }
    | undefined;
  return { invalid: row?.invalid ?? 0, gap: row?.gap === 1, accepted: row?.accepted === 1 };
}

export function putLensState(db: Db, runId: string, lens: string, state: LensState): void {
  db.prepare(
    `INSERT INTO lens_state (run_id, lens, invalid, gap, accepted) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, lens) DO UPDATE SET invalid = excluded.invalid, gap = excluded.gap, accepted = excluded.accepted`,
  ).run(runId, lens, state.invalid, state.gap ? 1 : 0, state.accepted ? 1 : 0);
}

export function findingIds(db: Db, runId: string): string[] {
  return (db.prepare('SELECT id FROM findings WHERE run_id = ? ORDER BY id').all(runId) as { id: string }[]).map((r) => r.id);
}

export function listFindings(db: Db, runId: string): StoredFinding[] {
  const rows = db.prepare('SELECT id, lens, json, status, round FROM findings WHERE run_id = ? ORDER BY id').all(runId) as {
    id: string;
    lens: FindingLens;
    json: string;
    status: string;
    round: number;
  }[];
  return rows.map((r) => ({ id: r.id, lens: r.lens, finding: JSON.parse(r.json) as Finding, status: r.status, round: r.round }));
}

export function listMarks(db: Db, runId: string): LensMark[] {
  return db.prepare('SELECT lens, usage_id, reason, written_by FROM lens_marks WHERE run_id = ? ORDER BY lens, usage_id').all(runId) as unknown as LensMark[];
}

/** Inserts accepted findings and marks. The caller has already rejected a conflicting submission. */
export function storeSubmission(
  db: Db,
  runId: string,
  lens: string,
  findings: readonly Finding[],
  marks: readonly { usage_id: string; reason: string; written_by: string }[],
  round: number,
): void {
  tx(db, () => {
    const ins = db.prepare('INSERT INTO findings (run_id, id, lens, json, status, round) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of findings) ins.run(runId, f.id, lens, JSON.stringify(f), 'accepted', round);
    const mark = db.prepare('INSERT INTO lens_marks (run_id, lens, usage_id, reason, written_by) VALUES (?, ?, ?, ?, ?)');
    for (const m of marks) mark.run(runId, lens, m.usage_id, m.reason, m.written_by);
  });
}
