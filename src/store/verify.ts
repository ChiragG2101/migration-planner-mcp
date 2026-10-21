// Store helpers for the verify loop (M8, migration 007).
import type { Db } from './db.js';
import type { CheckResult, Gate7Result, CodemodResult, StageDecision } from '../schema/verify.js';

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

export interface SandboxRow {
  run_id: string;
  path: string;
  source_head: string;
  created_at: string;
}

export function putSandbox(db: Db, row: SandboxRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO sandboxes (run_id, path, source_head, created_at) VALUES (?, ?, ?, ?)`,
  ).run(row.run_id, row.path, row.source_head, row.created_at);
}

export function getSandbox(db: Db, runId: string): SandboxRow | undefined {
  return db.prepare(`SELECT * FROM sandboxes WHERE run_id = ?`).get(runId) as SandboxRow | undefined;
}

// ---------------------------------------------------------------------------
// Baseline checks
// ---------------------------------------------------------------------------

export interface BaselineCheckRow {
  run_id: string;
  check_name: string;
  status: 'pass' | 'fail' | 'baseline_failing';
  exit_code: number | null;
  output: string | null;
  junit_json: string | null;
}

export function putBaselineCheck(db: Db, row: BaselineCheckRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO baseline_checks (run_id, check_name, status, exit_code, output, junit_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.run_id, row.check_name, row.status, row.exit_code ?? null, row.output ?? null, row.junit_json ?? null);
}

export function listBaselineChecks(db: Db, runId: string): BaselineCheckRow[] {
  return db.prepare(`SELECT * FROM baseline_checks WHERE run_id = ?`).all(runId) as unknown as BaselineCheckRow[];
}

// ---------------------------------------------------------------------------
// Stage attempts
// ---------------------------------------------------------------------------

export interface StageAttemptRow {
  run_id: string;
  stage_id: string;
  attempt: number;
  codemods_json: string;
  patch_hash: string | null;
  checks_json: string;
  gate7_json: string;
  decision: StageDecision;
}

export function putStageAttempt(db: Db, row: StageAttemptRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO stage_attempts
     (run_id, stage_id, attempt, codemods_json, patch_hash, checks_json, gate7_json, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.run_id,
    row.stage_id,
    row.attempt,
    row.codemods_json,
    row.patch_hash ?? null,
    row.checks_json,
    row.gate7_json,
    row.decision,
  );
}

export function listStageAttempts(db: Db, runId: string, stageId: string): StageAttemptRow[] {
  return db
    .prepare(`SELECT * FROM stage_attempts WHERE run_id = ? AND stage_id = ? ORDER BY attempt ASC`)
    .all(runId, stageId) as unknown as StageAttemptRow[];
}

export function latestStageAttempt(db: Db, runId: string, stageId: string): StageAttemptRow | undefined {
  return db
    .prepare(`SELECT * FROM stage_attempts WHERE run_id = ? AND stage_id = ? ORDER BY attempt DESC LIMIT 1`)
    .get(runId, stageId) as unknown as StageAttemptRow | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseCodemods(json: string): CodemodResult[] {
  return JSON.parse(json) as CodemodResult[];
}

export function parseChecks(json: string): CheckResult[] {
  return JSON.parse(json) as CheckResult[];
}

export function parseGate7(json: string): Gate7Result {
  return JSON.parse(json) as Gate7Result;
}
