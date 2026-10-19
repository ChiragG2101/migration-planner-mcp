-- 005: lens findings and the usages a lens marks out of scope (M5).
-- 004 is the doc cache (M4). `round` is 1 until validate_plan (M6).
-- lens_packets freezes the usage IDs a submission may name.
-- lens_state counts invalid submissions toward the one retry, then the gap.

CREATE TABLE findings (
  run_id  TEXT NOT NULL REFERENCES runs(id),
  id      TEXT NOT NULL,
  lens    TEXT NOT NULL,
  json    TEXT NOT NULL,
  status  TEXT NOT NULL CHECK (status IN ('accepted')),
  round   INTEGER NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX findings_lens ON findings(run_id, lens);

CREATE TABLE lens_marks (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  lens       TEXT NOT NULL,
  usage_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  written_by TEXT NOT NULL,
  PRIMARY KEY (run_id, lens, usage_id)
);

CREATE TABLE lens_packets (
  run_id          TEXT NOT NULL REFERENCES runs(id),
  lens            TEXT NOT NULL,
  usage_ids_json  TEXT NOT NULL,
  PRIMARY KEY (run_id, lens)
);

CREATE TABLE lens_state (
  run_id   TEXT NOT NULL REFERENCES runs(id),
  lens     TEXT NOT NULL,
  invalid  INTEGER NOT NULL,
  gap      INTEGER NOT NULL CHECK (gap IN (0, 1)),
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  PRIMARY KEY (run_id, lens)
);
