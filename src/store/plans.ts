// The built plan and its validate_plan rounds (M6). The stored JSON is the
// pure Plan object; round and status are columns, so run-loop state never
// enters the plan bytes (docs/design.md D37).
import type { GateResult, Plan, PlanStatus } from '../schema/plan.js';
import type { Db } from './db.js';

export interface StoredPlan {
  plan: Plan;
  round: number;
  status: PlanStatus;
}

export function getPlan(db: Db, runId: string): StoredPlan | undefined {
  const row = db.prepare('SELECT json, round, status FROM plans WHERE run_id = ?').get(runId) as
    | { json: string; round: number; status: PlanStatus }
    | undefined;
  return row && { plan: JSON.parse(row.json) as Plan, round: row.round, status: row.status };
}

/** Inserts or replaces the run's plan at the given round and status. */
export function putPlan(db: Db, runId: string, plan: Plan, round: number, status: PlanStatus): void {
  db.prepare(
    `INSERT INTO plans (run_id, json, round, status) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET json = excluded.json, round = excluded.round, status = excluded.status`,
  ).run(runId, JSON.stringify(plan), round, status);
}

export interface PlanRound {
  round: number;
  status: Exclude<PlanStatus, 'draft'>;
  results: GateResult[];
}

export function putPlanRound(db: Db, runId: string, round: number, status: PlanRound['status'], results: readonly GateResult[]): void {
  db.prepare(
    `INSERT INTO plan_rounds (run_id, round, status, results_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id, round) DO UPDATE SET status = excluded.status, results_json = excluded.results_json`,
  ).run(runId, round, status, JSON.stringify(results));
}

export function latestRound(db: Db, runId: string): PlanRound | undefined {
  const row = db.prepare('SELECT round, status, results_json FROM plan_rounds WHERE run_id = ? ORDER BY round DESC LIMIT 1').get(runId) as
    | { round: number; status: PlanRound['status']; results_json: string }
    | undefined;
  return row && { round: row.round, status: row.status, results: JSON.parse(row.results_json) as GateResult[] };
}

export function roundsFor(db: Db, runId: string): PlanRound[] {
  const rows = db.prepare('SELECT round, status, results_json FROM plan_rounds WHERE run_id = ? ORDER BY round').all(runId) as {
    round: number;
    status: PlanRound['status'];
    results_json: string;
  }[];
  return rows.map((r) => ({ round: r.round, status: r.status, results: JSON.parse(r.results_json) as GateResult[] }));
}
