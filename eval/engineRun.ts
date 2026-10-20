// Shared engine driver for eval tooling (M7). Everything here runs HEAD's
// deterministic engine over a read-only repo path, with Context7 forced off
// (apiKey: null) so no replay or truth derivation ever touches the network
// (C1, C6, D17). Output always goes to a temp folder outside the repo, which is
// removed afterwards, so the engine's "never write the repo" rule holds (C3).
// Outside the engine: src/ never imports this (INV-40).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeEngine, createEngine, findUsages, scanRepo, type Engine } from '../src/core/index.js';
import type { Usage } from '../src/schema/usage.js';
import { repoHash } from '../scripts/repo-hash.js';

export interface ScanResult {
  usages: Usage[];
  adapter: string;
}

/** Scan a repo path at HEAD's engine and page through all usages. The engine is created with Context7 off. */
export async function scanUsages(repoPath: string, source: { name: string }, target: { name: string; version: string }): Promise<ScanResult> {
  const out = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-eval-'));
  const engine = createEngine({ out, docs: { apiKey: null } });
  try {
    return await scanUsagesWith(engine, repoPath, source, target);
  } finally {
    closeEngine(engine);
    rmSync(out, { recursive: true, force: true });
  }
}

/** As scanUsages, but on a caller-owned engine (so a run can keep going after the scan). Returns the run id too. */
export async function scanUsagesWith(
  engine: Engine,
  repoPath: string,
  source: { name: string },
  target: { name: string; version: string },
): Promise<ScanResult & { run_id: string }> {
  const scan = await scanRepo(engine, { repo_path: repoPath, source, target });
  if (scan.status !== 'ok' || !scan.run) throw new Error(`scan_repo asked a question: ${JSON.stringify(scan.question)}`);
  const usages: Usage[] = [];
  let adapter: string;
  let cursor: string | undefined;
  do {
    const page = await findUsages(engine, { run_id: scan.run.run_id, limit: 1000, ...(cursor ? { cursor } : {}) });
    usages.push(...page.usages);
    adapter = page.summary.adapter;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return { usages, adapter, run_id: scan.run.run_id };
}

/** A temp output folder outside any repo, and a cleanup. For callers that drive a multi-step run. */
export function tempOut(): { out: string; cleanup: () => void } {
  const out = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-eval-'));
  return { out, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

/**
 * Run `fn` and fail the case if the repo at `root` was written during it
 * (INV-1, plan task 3: a mismatch fails the case outright). The engine never
 * writes the repo, so this is a guard that catches a bug or a bad fake planner.
 */
export async function assertRepoUntouched<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const before = repoHash(root);
  const result = await fn();
  const after = repoHash(root);
  if (before !== after) throw new Error(`repo at ${root} was modified during the run (hash ${before} -> ${after})`);
  return result;
}
