-- 002: the usage index and import graph (M2). Rows carry repo_id under the
-- run (C10). M3 reads the graph for fan-in, M6 for gate 5.

CREATE TABLE imports (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  repo_id    TEXT NOT NULL,
  from_file  TEXT NOT NULL,
  to_module  TEXT NOT NULL,
  to_file    TEXT,
  kind       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  lang       TEXT NOT NULL,
  confidence TEXT NOT NULL
);
CREATE INDEX imports_run_from ON imports(run_id, from_file);
CREATE INDEX imports_run_to ON imports(run_id, to_file);

CREATE TABLE symbols (
  run_id  TEXT NOT NULL REFERENCES runs(id),
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  file    TEXT NOT NULL,
  line    INTEGER NOT NULL,
  kind    TEXT NOT NULL
);
CREATE INDEX symbols_run_name ON symbols(run_id, name);

CREATE TABLE usages (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  repo_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  file         TEXT NOT NULL,
  line_start   INTEGER NOT NULL,
  line_end     INTEGER NOT NULL,
  snippet_hash TEXT NOT NULL,
  kind         TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  module       TEXT,
  match_kind   TEXT,
  context      TEXT NOT NULL,
  via_json     TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  labels_json  TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX usages_run_kind ON usages(run_id, kind);
CREATE INDEX usages_run_file ON usages(run_id, file);
CREATE INDEX usages_run_symbol ON usages(run_id, symbol);

-- One row per run: the latest find_usages summary and the generation that
-- page cursors refer to.
CREATE TABLE usage_runs (
  run_id       TEXT PRIMARY KEY REFERENCES runs(id),
  generation   INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

-- Per-file facts keyed on content, so an unchanged file is not parsed again.
-- `extractor` names the adapter, its version and the file's script kind.
CREATE TABLE file_facts (
  extractor  TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  PRIMARY KEY (extractor, sha256)
);
