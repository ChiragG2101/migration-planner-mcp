import type { Db } from './db.js';

export function campaignExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM campaigns WHERE id = ?').get(id) !== undefined;
}

export function ensureCampaign(db: Db, id: string, createdAt: string): void {
  db.prepare('INSERT OR IGNORE INTO campaigns (id, created_at, name) VALUES (?, ?, NULL)').run(id, createdAt);
}

export function ensureRepo(db: Db, repoId: string, campaignId: string, rootRealpath: string): void {
  db.prepare('INSERT OR IGNORE INTO repos (id, campaign_id, root_realpath) VALUES (?, ?, ?)').run(
    repoId,
    campaignId,
    rootRealpath,
  );
}

export function repoRoot(db: Db, repoId: string, campaignId: string): string | undefined {
  const row = db.prepare('SELECT root_realpath FROM repos WHERE id = ? AND campaign_id = ?').get(repoId, campaignId) as
    | { root_realpath: string }
    | undefined;
  return row?.root_realpath;
}
