-- 006: the built plan and its validate_plan rounds (M6). 005 is findings (M5).
-- One row per run: the latest plan JSON, its round and status. round is 1 at
-- merge_findings and increments on each validate_plan; status is draft until
-- validate_plan sets passed, failed or capped. The pure Plan object lives in
-- json so schema://plan and replay never carry run-loop state (D37).

CREATE TABLE plans (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES runs(id),
  json   TEXT NOT NULL,
  round  INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'passed', 'failed', 'capped'))
);

-- Each validate_plan round, kept as the audit trail (gate.result events carry
-- the findings before and after; this is the per-round gate verdict).
CREATE TABLE plan_rounds (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  round        INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'capped')),
  results_json TEXT NOT NULL,
  PRIMARY KEY (run_id, round)
);
