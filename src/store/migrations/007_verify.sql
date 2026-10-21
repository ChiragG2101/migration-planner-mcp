-- 007: sandboxed verify loop (M8). 006 is plans.
-- sandboxes: one row per sandbox created for a run.
-- baseline_checks: the result of each check on the unmodified sandbox.
-- stage_attempts: each attempt to verify a stage (codemods + patch + checks + gate 7).

CREATE TABLE sandboxes (
  run_id      TEXT NOT NULL REFERENCES runs(id),
  path        TEXT NOT NULL,
  source_head TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (run_id)
);

CREATE TABLE baseline_checks (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  check_name TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'baseline_failing')),
  exit_code  INTEGER,
  output     TEXT,
  junit_json TEXT,
  PRIMARY KEY (run_id, check_name)
);

CREATE TABLE stage_attempts (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  stage_id   TEXT NOT NULL,
  attempt    INTEGER NOT NULL,
  codemods_json TEXT NOT NULL,
  patch_hash TEXT,
  checks_json   TEXT NOT NULL,
  gate7_json    TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('kept', 'rejected', 'unresolved', 'skipped')),
  PRIMARY KEY (run_id, stage_id, attempt)
);
