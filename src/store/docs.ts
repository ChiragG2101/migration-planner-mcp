// The doc cache and the per-run retrieval log (M4). The cache is global so a
// later run works offline; run_docs is the list gate 3 (M6) cites against.
import type { Db } from './db.js';

export type DocStatus = 'fresh' | 'stale' | 'unverified';
export type FetchedBy = 'engine' | 'agent' | 'knowledge';
export type DocMode = 'register' | 'query' | 'cache' | 'fallback';

export interface CacheRow {
  doc_id: string;
  library: string;
  version: string;
  topic: string;
  url: string;
  content: string;
  fetched_at: string;
  source: FetchedBy;
}

export interface RunDocRow extends CacheRow {
  run_id: string;
  mode: DocMode;
  status: DocStatus;
  fetched_by: FetchedBy;
  official: boolean;
}

/** Inserts a cache row. The same doc_id is a no-op, so re-registering does not move fetched_at. */
export function putCache(db: Db, row: CacheRow): void {
  db.prepare(
    `INSERT INTO doc_cache (doc_id, library, version, topic, url, content, fetched_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO NOTHING`,
  ).run(row.doc_id, row.library, row.version, row.topic, row.url, row.content, row.fetched_at, row.source);
}

/** Records a doc on a run. A second link of the same doc_id is a no-op. */
export function linkRunDoc(db: Db, row: Pick<RunDocRow, 'run_id' | 'doc_id' | 'mode' | 'status' | 'fetched_by' | 'official'>): void {
  db.prepare(
    `INSERT INTO run_docs (run_id, doc_id, mode, status, fetched_by, official)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, doc_id) DO NOTHING`,
  ).run(row.run_id, row.doc_id, row.mode, row.status, row.fetched_by, row.official ? 1 : 0);
}

export function listCache(db: Db): CacheRow[] {
  return db.prepare('SELECT doc_id, library, version, topic, url, content, fetched_at, source FROM doc_cache').all() as unknown as CacheRow[];
}

/** The docs linked to a run, joined to the cache for the URL and the text gate 3 compares. */
export function listRunDocs(db: Db, runId: string): RunDocRow[] {
  const rows = db
    .prepare(
      `SELECT r.run_id, r.doc_id, r.mode, r.status, r.fetched_by, r.official,
              c.library, c.version, c.topic, c.url, c.content, c.fetched_at, c.source
       FROM run_docs r JOIN doc_cache c ON c.doc_id = r.doc_id
       WHERE r.run_id = ?
       ORDER BY c.library, c.topic, c.version, r.doc_id`,
    )
    .all(runId) as unknown as (Omit<RunDocRow, 'official'> & { official: number })[];
  return rows.map((r) => ({ ...r, official: r.official === 1 }));
}

/**
 * The check gate 3 (M6) applies to one citation: the doc_id was linked in this
 * run and the URL is the one the docs tool stored.
 */
export function docRefAccepted(docs: readonly { doc_id: string; url: string }[], ref: { doc_id: string; url: string }): boolean {
  return docs.some((d) => d.doc_id === ref.doc_id && d.url === ref.url);
}

/** Drops the oldest cache rows until the content is within `maxBytes`. Docs cited by the newest `protectRuns` runs stay. */
export function evictCache(db: Db, maxBytes: number, protectRuns: number): void {
  const protectedIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT d.doc_id FROM run_docs d
           WHERE d.run_id IN (SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?)`,
        )
        .all(protectRuns) as { doc_id: string }[]
    ).map((r) => r.doc_id),
  );
  const rows = db.prepare('SELECT doc_id, content, fetched_at FROM doc_cache ORDER BY fetched_at ASC, doc_id ASC').all() as {
    doc_id: string;
    content: string;
    fetched_at: string;
  }[];
  let total = rows.reduce((n, r) => n + r.content.length, 0);
  const del = db.prepare('DELETE FROM doc_cache WHERE doc_id = ?');
  for (const row of rows) {
    if (total <= maxBytes) return;
    if (protectedIds.has(row.doc_id)) continue;
    del.run(row.doc_id);
    total -= row.content.length;
  }
}
