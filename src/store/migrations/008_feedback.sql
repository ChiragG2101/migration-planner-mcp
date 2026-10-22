-- 008: feedback on a run (M9 record_feedback). 007 is the verify loop (D47),
-- so the M9 plan's 007_feedback.sql is 008 here (docs/design.md D54).
-- n counts entries per run from 1; export_path is relative to the output folder.

CREATE TABLE feedback (
  run_id      TEXT NOT NULL REFERENCES runs(id),
  n           INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('wrong', 'missing', 'severity_wrong', 'bad_patch', 'other')),
  finding_id  TEXT,
  stage_id    TEXT,
  note        TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  created_at  TEXT NOT NULL,
  export_path TEXT NOT NULL,
  PRIMARY KEY (run_id, n)
);
