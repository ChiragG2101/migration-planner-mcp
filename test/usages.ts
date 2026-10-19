// Builds a usage index for a small inline repo, for the language and usage
// adapter tests. Runs the real pipeline (walk, parse, resolve, detect) with an
// in-memory facts cache, and keeps the context the adapter saw.
import path from 'node:path';
import { analyzeRepo, DEFAULT_LIMITS } from '../src/analysis/scanner.js';
import type { UsageAdapter, UsageContext } from '../src/analysis/usages/adapter.js';
import { buildUsageIndex, graphOnlyAdapter, type BuildResult, type FactsCache } from '../src/analysis/usages/index.js';
import { repoIdFor } from '../src/pipeline/ingest.js';
import { resolveRepoRoot } from '../src/security/pathBoundary.js';
import type { Usage } from '../src/schema/usage.js';
import { tmpDir, writeTree } from './helpers.js';

export interface Built extends BuildResult {
  root: string;
  ctx: UsageContext;
  cache: Map<string, string>;
}

export function memoryCache(map = new Map<string, string>()): FactsCache & { map: Map<string, string> } {
  return { map, get: (e, sha) => map.get(`${e} ${sha}`), put: (e, sha, json) => void map.set(`${e} ${sha}`, json) };
}

/** Writes `files` into a fresh repo (or uses `root`) and builds its usage index. */
export async function build(
  files: Record<string, string>,
  opts: { adapter?: UsageAdapter; targets?: Record<string, string>; root?: string; cache?: Map<string, string> } = {},
): Promise<Built> {
  const dir = opts.root ?? path.join(tmpDir(), 'repo');
  writeTree(dir, files);
  const root = resolveRepoRoot(dir);
  const repoId = repoIdFor(root);
  const inner = opts.adapter ?? graphOnlyAdapter;
  let ctx: UsageContext | undefined;
  const adapter: UsageAdapter = { ...inner, detect: (c) => ((ctx = c), inner.detect(c)) };
  const cache = memoryCache(opts.cache);
  const result = await buildUsageIndex({
    root,
    repoId,
    repo: analyzeRepo(root, repoId, DEFAULT_LIMITS),
    adapter,
    targets: opts.targets ?? {},
    cache,
  });
  return { ...result, root, ctx: ctx!, cache: cache.map };
}

/** `file:line kind symbol` for each usage, for compact assertions. */
export const brief = (usages: readonly Usage[]): string[] => usages.map((u) => `${u.file}:${u.line_start} ${u.kind} ${u.symbol}`);

export const ofKind = (usages: readonly Usage[], kind: string): Usage[] => usages.filter((u) => u.kind === kind);
