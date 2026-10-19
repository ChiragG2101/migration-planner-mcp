// Core API for find_usages. A call without a cursor recomputes the run's
// usage index (unchanged files come from the sha256 cache) and returns the
// first page; a call with a cursor pages through that same index. The
// response never truncates silently: it gives the total and says when it is
// one page of several.
import { z } from 'zod';
import { analyzeRepo } from '../analysis/scanner.js';
import { buildUsageIndex, usageAdapterFor } from '../analysis/usages/index.js';
import { resolveRepo } from '../pipeline/ingest.js';
import { FindUsagesInput, type FindUsagesOutput } from '../schema/usage.js';
import type { Versions } from '../schema/ingest.js';
import { InputError } from '../security/errors.js';
import { repoRoot } from '../store/campaigns.js';
import { getRun, setRunStatus } from '../store/runs.js';
import { countUsages, getFileFacts, getUsageRun, putFileFacts, queryUsages, storeUsageIndex, type UsageFilter } from '../store/usages.js';
import { runTool, sessionForRun, type Engine } from './engine.js';

const DEFAULT_LIMIT = 200;

interface Cursor {
  g: number;
  o: number;
  f: UsageFilter;
}

const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.g === 'number' && typeof c.o === 'number' && typeof c.f === 'object') return c;
  } catch {
    // Falls through to the error below.
  }
  throw new InputError('bad_cursor', 'cursor is not one this tool returned');
}

const sameFilter = (a: UsageFilter, b: UsageFilter): boolean => a.kind === b.kind && a.file === b.file && a.symbol === b.symbol;

export async function findUsages(engine: Engine, raw: unknown): Promise<FindUsagesOutput> {
  const parsed = FindUsagesInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const input = parsed.data;
  const session = sessionForRun(engine, input.run_id);
  if (!session) {
    throw new InputError('unknown_run', `no run ${input.run_id} in this session; call scan_repo first (it returns the same run for the same repo and versions)`);
  }
  return runTool(engine, session, 'find_usages', input, async (call) => {
    call.attachRun(input.run_id);
    const run = getRun(session.db, input.run_id)!;
    const filter: UsageFilter = { kind: input.kind, file: input.file, symbol: input.symbol };
    const limit = input.limit ?? DEFAULT_LIMIT;
    let offset = 0;
    let state = getUsageRun(session.db, run.id);

    if (input.cursor !== undefined) {
      const c = decodeCursor(input.cursor);
      if (!state || c.g !== state.generation) throw new InputError('stale_cursor', 'the usages were recomputed since this cursor; call again without a cursor');
      if (!sameFilter(c.f, filter)) throw new InputError('cursor_filter_mismatch', 'a cursor must be used with the same filters as the call that returned it');
      offset = c.o;
    } else {
      const root = repoRoot(session.db, run.repo_id, run.campaign_id);
      if (!root) throw new InputError('unknown_repo', `run ${run.id} has no recorded repo`);
      const repo = resolveRepo(root);
      if (repo.repoId !== run.repo_id) throw new InputError('repo_moved', `the repo for run ${run.id} is no longer at ${root}`);
      const versions = JSON.parse(run.versions_json) as Versions;
      const adapter = usageAdapterFor(versions.source.name);
      const started = engine.now().getTime();
      const facts = analyzeRepo(repo.root, repo.repoId, engine.limits);
      const built = await buildUsageIndex({
        root: repo.root,
        repoId: repo.repoId,
        repo: facts,
        adapter,
        // M2 knows the run's own target; M3 adds the companion targets it composes from knowledge.
        targets: { [versions.target.name]: versions.target.version },
        cache: { get: (e, sha) => getFileFacts(session.db, e, sha), put: (e, sha, json) => putFileFacts(session.db, e, sha, json) },
      });
      const summary = { ...built.summary, duration_ms: engine.now().getTime() - started };
      storeUsageIndex(session.db, run.id, repo.repoId, { imports: built.imports, symbols: built.symbols, usages: built.usages, summary });
      call.event('usages.result', summary);
      setRunStatus(session.db, run.id, 'usages_found');
      state = getUsageRun(session.db, run.id)!;
    }

    const total = countUsages(session.db, run.id, filter);
    const usages = queryUsages(session.db, run.id, filter, offset, limit);
    const end = offset + usages.length;
    const more = end < total;
    const paginated = more || offset > 0;
    return {
      run_id: run.id,
      total,
      returned: usages.length,
      paginated,
      next_cursor: more ? encodeCursor({ g: state.generation, o: end, f: filter }) : null,
      note: paginated ? `usages ${offset + 1}-${end} of ${total}${more ? '; pass next_cursor for the rest' : ''}` : null,
      usages,
      summary: state.summary,
    };
  });
}
