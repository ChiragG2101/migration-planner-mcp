-- 004: the doc cache and the per-run retrieval log (M4). 003 is scope (M3).
-- doc_cache is global across runs, keyed by doc_id, so a later run can reuse
-- it offline. run_docs is what gate 3 reads: every doc this run may cite.

CREATE TABLE doc_cache (
  doc_id     TEXT PRIMARY KEY,
  library    TEXT NOT NULL,
  version    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  url        TEXT NOT NULL,
  content    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('engine', 'agent', 'knowledge'))
);
CREATE INDEX doc_cache_lib ON doc_cache(library, version);

CREATE TABLE run_docs (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  doc_id     TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('register', 'query', 'cache', 'fallback')),
  status     TEXT NOT NULL CHECK (status IN ('fresh', 'stale', 'unverified')),
  fetched_by TEXT NOT NULL CHECK (fetched_by IN ('engine', 'agent', 'knowledge')),
  official   INTEGER NOT NULL CHECK (official IN (0, 1)),
  PRIMARY KEY (run_id, doc_id)
);
CREATE INDEX run_docs_run ON run_docs(run_id);
