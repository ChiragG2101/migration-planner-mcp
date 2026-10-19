import type { Db } from './db.js';

export interface RunRow {
  id: string;
  campaign_id: string;
  repo_id: string;
  created_at: string;
  input_json: string;
  versions_json: string;
  idem_key: string;
  status: string;
}

export function findRunByIdemKey(db: Db, idemKey: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE idem_key = ?').get(idemKey) as RunRow | undefined;
}

export function getRun(db: Db, id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
}

export function insertRun(db: Db, run: RunRow): void {
  db.prepare(
    'INSERT INTO runs (id, campaign_id, repo_id, created_at, input_json, versions_json, idem_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(run.id, run.campaign_id, run.repo_id, run.created_at, run.input_json, run.versions_json, run.idem_key, run.status);
}

export function setRunStatus(db: Db, id: string, status: string): void {
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
}

export interface FileRow {
  path: string;
  sha256: string;
  size: number;
}

/** Records the files a scan read. A re-scan of the same run replaces its rows. */
export function recordFiles(db: Db, runId: string, repoId: string, files: readonly FileRow[]): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM files WHERE run_id = ?').run(runId);
    const insert = db.prepare('INSERT INTO files (run_id, repo_id, path, sha256, size) VALUES (?, ?, ?, ?, ?)');
    for (const f of files) insert.run(runId, repoId, f.path, f.sha256, f.size);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
