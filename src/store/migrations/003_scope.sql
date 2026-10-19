-- 003: scope answers and the usages a scope decision excludes (M3). M5 and M6
-- read the same rows. Scope freezes once a lens packet is fetched or a merge
-- starts; those events are written by later milestones.

CREATE TABLE scope (
  run_id            TEXT PRIMARY KEY REFERENCES runs(id),
  answers_json      TEXT NOT NULL,
  defaults_json     TEXT NOT NULL,
  out_of_scope_json TEXT NOT NULL,
  small_max         INTEGER NOT NULL
);
