// Scope answers and the usages they exclude (D12, D29). One row per run.
import type { Db } from './db.js';

export interface OutOfScope {
  usage_id: string;
  written_by: 'scope';
  reason: string;
}

export interface ScopeRow {
  answers: Record<string, string | string[]>;
  defaults: string[];
  out_of_scope: OutOfScope[];
  small_max: number;
}

export function getScope(db: Db, runId: string): ScopeRow | undefined {
  const row = db.prepare('SELECT answers_json, defaults_json, out_of_scope_json, small_max FROM scope WHERE run_id = ?').get(runId) as
    | { answers_json: string; defaults_json: string; out_of_scope_json: string; small_max: number }
    | undefined;
  if (!row) return undefined;
  return {
    answers: JSON.parse(row.answers_json) as ScopeRow['answers'],
    defaults: JSON.parse(row.defaults_json) as string[],
    out_of_scope: JSON.parse(row.out_of_scope_json) as OutOfScope[],
    small_max: row.small_max,
  };
}

export function putScope(db: Db, runId: string, row: ScopeRow): void {
  db.prepare(
    `INSERT INTO scope (run_id, answers_json, defaults_json, out_of_scope_json, small_max) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET answers_json = excluded.answers_json, defaults_json = excluded.defaults_json,
       out_of_scope_json = excluded.out_of_scope_json, small_max = excluded.small_max`,
  ).run(runId, JSON.stringify(row.answers), JSON.stringify(row.defaults), JSON.stringify(row.out_of_scope), row.small_max);
}
