// Freshness, the doc id and the text a fallback doc serves (M4, D14).
import { createHash } from 'node:crypto';
import type { ReviewedRule } from '../schema/knowledge.js';
import type { CacheRow, DocStatus, FetchedBy } from '../store/docs.js';
import { isOfficialUrl } from './officialUrl.js';

/** A cached engine or agent doc younger than this is fresh; older is stale. */
export const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Content bytes kept in doc_cache. Docs cited by the newest runs are not evicted. */
export const CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** How many of the newest runs keep their cached docs. */
export const PROTECT_RUNS = 20;

/** One wait after a 429, then the caller falls back. */
export const BACKOFF_MS = 1000;

export const CONTEXT7_TIMEOUT_MS = 10_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `sha256(library@version|url|content_hash)`. The same inputs always give the same id. */
export function docId(library: string, version: string, url: string, content: string): string {
  return sha256(`${library}@${version}|${url}|${sha256(content)}`);
}

export function isFresh(fetchedAt: string, now: Date, freshForMs: number): boolean {
  const t = Date.parse(fetchedAt);
  return !Number.isNaN(t) && now.getTime() - t <= freshForMs && now.getTime() - t >= 0;
}

/**
 * Who fetched a doc, and whether it counts as verified. Knowledge is always
 * unverified: a URL is not the text. An agent doc from outside doc_sources is
 * unverified too. Cache age only moves an official agent doc or an engine doc
 * between fresh and stale.
 */
export function describeDoc(input: {
  fetchedBy: FetchedBy;
  url: string;
  prefixes: readonly string[];
  fresh: boolean;
}): { official: boolean; status: DocStatus } {
  const official = isOfficialUrl(input.url, input.prefixes);
  if (input.fetchedBy === 'knowledge' || (input.fetchedBy === 'agent' && !official)) return { official, status: 'unverified' };
  return { official, status: input.fresh ? 'fresh' : 'stale' };
}

/** The newest fresh row for this library, version and topic, else the newest stale one. Knowledge rows are not cache hits. */
export function cacheHit(rows: readonly CacheRow[], library: string, version: string, topic: string, now: Date, freshForMs: number): { row: CacheRow; status: 'fresh' | 'stale' } | undefined {
  const matches = rows.filter((r) => r.library === library && r.version === version && r.topic === topic && r.source !== 'knowledge');
  const fresh = matches.filter((r) => isFresh(r.fetched_at, now, freshForMs)).sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1));
  if (fresh[0]) return { row: fresh[0], status: 'fresh' };
  const stale = matches.filter((r) => !isFresh(r.fetched_at, now, freshForMs)).sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1));
  if (stale[0]) return { row: stale[0], status: 'stale' };
  return undefined;
}

/** The text a rule fallback serves. The doc_id hashes this, not the URL alone. */
export function ruleText(rule: ReviewedRule): string {
  return [rule.title, '', rule.concern, '', `old: ${rule.mapping.from}`, `new: ${rule.mapping.to}`, '', rule.notes].join('\n');
}
