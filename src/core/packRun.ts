// The pack a run was made with, and its composition. Shared by get_rule_pack,
// assess_risk, propose_scope and set_scope.
import type { Usage } from '../schema/usage.js';
import type { RunVersions } from '../schema/ingest.js';
import { composePack, type PackComposition } from '../rules/compose.js';
import { packForRun, readRunVersions } from '../pipeline/ingest.js';
import type { PackBundle } from '../rules/loader.js';
import { bindsTo } from '../rules/match.js';
import { InputError, NotBuiltError } from '../security/errors.js';
import { getRun, type RunRow } from '../store/runs.js';
import { countUsages, listImports, queryUsages, getUsageRun, type ImportRow } from '../store/usages.js';
import { sessionForRun, type Engine, type Session } from './engine.js';

export const noPack = (library: string): string => `no pack for ${library} in v0.1`;

export interface RunPack {
  session: Session;
  run: RunRow;
  versions: RunVersions;
  pack: PackBundle;
}

export function openRunPack(engine: Engine, runId: string): RunPack {
  const session = sessionForRun(engine, runId);
  if (!session) throw new InputError('unknown_run', `no run ${runId} in this session; call scan_repo first`);
  const run = getRun(session.db, runId)!;
  const versions = readRunVersions(run.id, run.versions_json);
  const pack = packForRun(engine.bundle, run.id, versions);
  if (!pack) throw new NotBuiltError(noPack(versions.source.name));
  return { session, run, versions, pack };
}

export function composeRun(pack: PackBundle, versions: RunVersions, opts: { stopAt?: string; usages?: readonly Usage[] } = {}): PackComposition {
  const primary = pack.pack.libraries.find((l) => l.role === 'primary')!.id;
  return composePack(pack.pack, pack.libs, {
    installed: { ...versions.companions, [primary]: versions.source.version },
    target: versions.target.version,
    ...(opts.stopAt !== undefined ? { stop_at: opts.stopAt } : {}),
    ...(opts.usages ? { matched: (rule) => opts.usages!.some((u) => u.match_kind !== null && bindsTo(rule.match, u)) } : {}),
  });
}

export function allUsages(session: Session, runId: string): Usage[] {
  const total = countUsages(session.db, runId, {});
  return queryUsages(session.db, runId, {}, 0, Math.max(total, 1));
}

export function requireUsages(session: Session, runId: string): { usages: Usage[]; imports: ImportRow[]; unparsed: number; unresolved: number; skipped: number } {
  const state = getUsageRun(session.db, runId);
  if (!state) throw new InputError('no_usages', `run ${runId} has no usage index; call find_usages first`);
  return {
    usages: allUsages(session, runId),
    imports: listImports(session.db, runId),
    unparsed: state.summary.unparsed_files.length,
    unresolved: state.summary.unresolved_dynamic.length,
    skipped: state.summary.skipped_by_limit.length,
  };
}
