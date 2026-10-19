// A scanned Next.js run with Context7 forced off, unless a test passes a transport.
import { copyFixture, tmpDir } from '../../helpers.js';
import { closeEngine, createEngine, findUsages, getRulePack, scanRepo, type Engine, type EngineOptions } from '../../../src/core/index.js';
import { openSession } from '../../../src/core/engine.js';
import type { Db } from '../../../src/store/db.js';

export async function prepare(opts: { target?: string; docs?: EngineOptions['docs']; now?: () => Date } = {}): Promise<{
  engine: Engine;
  repo: string;
  runId: string;
  db: () => Db;
  close: () => void;
}> {
  const engine = createEngine({
    out: tmpDir(),
    now: opts.now ?? (() => new Date('2026-10-20T00:00:00Z')),
    docs: { apiKey: null, ...opts.docs },
  });
  const repo = copyFixture('next-basic');
  const scan = await scanRepo(engine, {
    repo_path: repo,
    source: { name: 'next' },
    target: { name: 'next', version: opts.target ?? '15.1.0' },
  });
  if (scan.status !== 'ok' || !scan.run) throw new Error(`scan did not start a run: ${scan.status}`);
  const runId = scan.run.run_id;
  await findUsages(engine, { run_id: runId });
  await getRulePack(engine, { run_id: runId });
  return { engine, repo, runId, db: () => openSession(engine, repo).db, close: () => closeEngine(engine) };
}
