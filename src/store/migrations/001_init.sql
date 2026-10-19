-- 001: the event spine. Campaign and repo IDs on everything (C10).

CREATE TABLE campaigns (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name       TEXT
);

CREATE TABLE repos (
  id            TEXT NOT NULL,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  root_realpath TEXT NOT NULL,
  PRIMARY KEY (id, campaign_id)
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  repo_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  idem_key      TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  FOREIGN KEY (repo_id, campaign_id) REFERENCES repos(id, campaign_id)
);

-- run_id is null only for a refusal or question that came before any run existed.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT REFERENCES runs(id),
  ts           TEXT NOT NULL,
  step         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  tokens_in    INTEGER,
  tokens_out   INTEGER
);
CREATE INDEX events_run ON events(run_id);

CREATE TABLE files (
  run_id  TEXT NOT NULL REFERENCES runs(id),
  repo_id TEXT NOT NULL,
  path    TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  size    INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);
