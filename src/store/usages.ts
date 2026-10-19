// The usage index, the import graph and the per-file facts cache.
import type { Usage, UsageSummary } from '../schema/usage.js';
import type { Db } from './db.js';

export interface ImportRow {
  from_file: string;
  to_module: string;
  to_file: string | null;
  kind: string;
  line: number;
  lang: string;
  confidence: string;
}

export interface SymbolRow {
  name: string;
  file: string;
  line: number;
  kind: string;
}

interface UsageRow {
  id: string;
  repo_id: string;
  file: string;
  line_start: number;
  line_end: number;
  snippet_hash: string;
  kind: string;
  symbol: string;
  module: string | null;
  match_kind: string | null;
  context: string;
  via_json: string;
  confidence: string;
  labels_json: string;
}

function tx(db: Db, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getFileFacts(db: Db, extractor: string, sha256: string): string | undefined {
  const row = db.prepare('SELECT facts_json FROM file_facts WHERE extractor = ? AND sha256 = ?').get(extractor, sha256) as
    | { facts_json: string }
    | undefined;
  return row?.facts_json;
}

export function putFileFacts(db: Db, extractor: string, sha256: string, factsJson: string): void {
  db.prepare('INSERT OR REPLACE INTO file_facts (extractor, sha256, facts_json) VALUES (?, ?, ?)').run(extractor, sha256, factsJson);
}

export interface UsageIndex {
  imports: readonly ImportRow[];
  symbols: readonly SymbolRow[];
  usages: readonly Usage[];
  summary: UsageSummary;
}

/** Replaces the run's graph, symbols and usages in one transaction and returns the new generation. */
export function storeUsageIndex(db: Db, runId: string, repoId: string, index: UsageIndex): number {
  let generation = 0;
  tx(db, () => {
    for (const table of ['imports', 'symbols', 'usages']) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
    const imp = db.prepare(
      'INSERT INTO imports (run_id, repo_id, from_file, to_module, to_file, kind, line, lang, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const i of index.imports) imp.run(runId, repoId, i.from_file, i.to_module, i.to_file, i.kind, i.line, i.lang, i.confidence);
    const sym = db.prepare('INSERT INTO symbols (run_id, repo_id, name, file, line, kind) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of index.symbols) sym.run(runId, repoId, s.name, s.file, s.line, s.kind);
    const use = db.prepare(
      `INSERT INTO usages (run_id, repo_id, id, seq, file, line_start, line_end, snippet_hash, kind, symbol, module, match_kind,
        context, via_json, confidence, labels_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    index.usages.forEach((u, seq) =>
      use.run(
        runId,
        u.repo_id,
        u.id,
        seq,
        u.file,
        u.line_start,
        u.line_end,
        u.snippet_hash,
        u.kind,
        u.symbol,
        u.module,
        u.match_kind,
        u.context,
        JSON.stringify(u.via),
        u.confidence,
        JSON.stringify(u.labels),
      ),
    );
    const prev = db.prepare('SELECT generation FROM usage_runs WHERE run_id = ?').get(runId) as { generation: number } | undefined;
    generation = (prev?.generation ?? 0) + 1;
    db.prepare('INSERT OR REPLACE INTO usage_runs (run_id, generation, summary_json) VALUES (?, ?, ?)').run(
      runId,
      generation,
      JSON.stringify(index.summary),
    );
  });
  return generation;
}

export function getUsageRun(db: Db, runId: string): { generation: number; summary: UsageSummary } | undefined {
  const row = db.prepare('SELECT generation, summary_json FROM usage_runs WHERE run_id = ?').get(runId) as
    | { generation: number; summary_json: string }
    | undefined;
  return row && { generation: row.generation, summary: JSON.parse(row.summary_json) as UsageSummary };
}

export interface UsageFilter {
  kind?: string | undefined;
  file?: string | undefined;
  symbol?: string | undefined;
}

function where(runId: string, f: UsageFilter): { sql: string; args: string[] } {
  const parts = ['run_id = ?'];
  const args = [runId];
  for (const key of ['kind', 'file', 'symbol'] as const) {
    const value = f[key];
    if (value !== undefined) {
      parts.push(`${key} = ?`);
      args.push(value);
    }
  }
  return { sql: parts.join(' AND '), args };
}

export function countUsages(db: Db, runId: string, filter: UsageFilter): number {
  const w = where(runId, filter);
  return (db.prepare(`SELECT COUNT(*) AS n FROM usages WHERE ${w.sql}`).get(...w.args) as { n: number }).n;
}

/** Usages in their stored order (file, line, kind, symbol), one page at a time. */
export function queryUsages(db: Db, runId: string, filter: UsageFilter, offset: number, limit: number): Usage[] {
  const w = where(runId, filter);
  const rows = db
    .prepare(`SELECT * FROM usages WHERE ${w.sql} ORDER BY seq LIMIT ? OFFSET ?`)
    .all(...w.args, limit, offset) as unknown as UsageRow[];
  return rows.map((r) => ({
    id: r.id,
    repo_id: r.repo_id,
    file: r.file,
    line_start: r.line_start,
    line_end: r.line_end,
    snippet_hash: r.snippet_hash,
    kind: r.kind,
    symbol: r.symbol,
    module: r.module,
    match_kind: r.match_kind as Usage['match_kind'],
    context: r.context,
    via: JSON.parse(r.via_json) as Usage['via'],
    confidence: r.confidence as Usage['confidence'],
    labels: JSON.parse(r.labels_json) as string[],
  }));
}

export function listImports(db: Db, runId: string): ImportRow[] {
  return db
    .prepare('SELECT from_file, to_module, to_file, kind, line, lang, confidence FROM imports WHERE run_id = ? ORDER BY from_file, line, to_module')
    .all(runId) as unknown as ImportRow[];
}

export function listSymbols(db: Db, runId: string, name?: string): SymbolRow[] {
  const rows =
    name === undefined
      ? db.prepare('SELECT name, file, line, kind FROM symbols WHERE run_id = ? ORDER BY file, line, name').all(runId)
      : db.prepare('SELECT name, file, line, kind FROM symbols WHERE run_id = ? AND name = ? ORDER BY file, line').all(runId, name);
  return rows as unknown as SymbolRow[];
}
