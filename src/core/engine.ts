// The engine context every core function runs in: the process level, where
// output goes, and the store. The output folder and store are opened only
// after the "not inside the repo" check passes, so a refused --out or --db
// never creates a file in the repo.
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS } from '../analysis/scanner.js';
import { describeBundle, loadBundled, type Bundle } from '../rules/loader.js';
import type { ScanLimits } from '../schema/scan.js';
import { InputError, NotBuiltError, PermissionError } from '../security/errors.js';
import { initLevel, type Level } from '../security/level.js';
import { isWithin, realpathAllowMissing } from '../security/pathBoundary.js';
import { assertOutsideRepos, enclosingRepoTop, openOutDir, registerRepoRoot, type OutWriter } from '../security/safeWrite.js';
import { openDb, type Db } from '../store/db.js';
import { appendEvent, type NewEvent } from '../store/events.js';
import { getRun } from '../store/runs.js';

// <package>/package.json, from both src/core/ and dist/core/.
export const ENGINE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

export interface EngineOptions {
  /** Output folder. Default: `.migration-planner/` next to the repo (docs/design.md D20). */
  out?: string;
  /** SQLite store. Default: `<out>/store.sqlite`. */
  db?: string;
  level?: Level;
  limits?: Partial<ScanLimits>;
  now?: () => Date;
  randomBytes?: (n: number) => Uint8Array;
  /** Where human-readable notes go (the adapters pass stderr). */
  log?: (message: string) => void;
  /** Knowledge and packs folder. Only the bundled one is accepted in v0.1. */
  rulesDir?: string;
}

export interface Session {
  readonly outDir: string;
  readonly dbPath: string;
  readonly writer: OutWriter;
  readonly db: Db;
}

export interface Engine {
  readonly limits: ScanLimits;
  readonly now: () => Date;
  readonly randomBytes: (n: number) => Uint8Array;
  readonly log: (message: string) => void;
  readonly options: Readonly<EngineOptions>;
  readonly sessions: Map<string, Session>;
  /** The loaded knowledge and packs; loading fails closed, so the engine never starts on knowledge it couldn't read. */
  readonly bundle: Bundle;
}

export function createEngine(options: EngineOptions = {}): Engine {
  initLevel(options.level ?? 0);
  const log = options.log ?? (() => {});
  const bundle = loadBundled(options.rulesDir);
  for (const line of describeBundle(bundle)) log(line);
  return {
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    now: options.now ?? (() => new Date()),
    randomBytes: options.randomBytes ?? ((n) => cryptoRandomBytes(n)),
    log,
    options,
    sessions: new Map(),
    bundle,
  };
}

export function closeEngine(engine: Engine): void {
  for (const s of engine.sessions.values()) s.db.close();
  engine.sessions.clear();
}

/**
 * The output folder for a repo: the --out flag, or `.migration-planner/` beside
 * the top of the git repo that contains it (beside the folder itself when it
 * is in no git repo), so the default never lands inside a repo (D24).
 */
export function outDirFor(engine: Engine, repoRoot: string): string {
  return path.resolve(engine.options.out ?? path.join(path.dirname(enclosingRepoTop(repoRoot)), '.migration-planner'));
}

/** Registers the repo and its enclosing git repo, refuses an --out or --db inside either, then opens (or reuses) the output folder and store. */
export function openSession(engine: Engine, repoRoot: string): Session {
  registerRepoRoot(repoRoot);
  registerRepoRoot(enclosingRepoTop(repoRoot));
  const out = outDirFor(engine, repoRoot);
  const dbPath = path.resolve(engine.options.db ?? path.join(out, 'store.sqlite'));
  // Both checks come before anything is created, so a refused --out or --db leaves no trace.
  assertOutsideRepos(out, '--out');
  assertOutsideRepos(dbPath, '--db');
  const cached = engine.sessions.get(dbPath);
  if (cached) return cached;
  const writer = openOutDir(out);
  const dbDir = realpathAllowMissing(path.dirname(dbPath));
  if (isWithin(writer.root, dbDir) && dbDir !== writer.root) writer.mkdir(path.relative(writer.root, dbDir), { level: 0 });
  const session: Session = { outDir: writer.root, dbPath, writer, db: openDb(dbPath) };
  engine.sessions.set(dbPath, session);
  engine.log(`output folder: ${writer.root} (outside the repo); store: ${dbPath}`);
  return session;
}

/** The open session whose store holds `runId`, or undefined. */
export function sessionForRun(engine: Engine, runId: string): Session | undefined {
  for (const s of engine.sessions.values()) if (getRun(s.db, runId)) return s;
  return undefined;
}

export interface ToolCall {
  /** Ties the call's events to a run once one exists. Events before it are held, then written with the run ID. */
  attachRun(runId: string): void;
  event(kind: string, payload: unknown): void;
}

export function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof PermissionError) return { name: err.name, code: err.code, message: err.message, details: err.details };
  if (err instanceof NotBuiltError || err instanceof InputError) return { name: err.name, code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

/**
 * Runs one tool call with `tool.start`, then `tool.end` or `tool.error`.
 * Events written before a run exists (a refusal or a question) have no run ID.
 */
export async function runTool<T>(engine: Engine, session: Session, step: string, input: unknown, fn: (call: ToolCall) => T | Promise<T>): Promise<T> {
  const started = engine.now();
  let runId: string | null = null;
  let held: NewEvent[] = [];
  const flush = (): void => {
    for (const e of held) appendEvent(session.db, { ...e, runId });
    held = [];
  };
  const call: ToolCall = {
    attachRun(id) {
      runId = id;
      flush();
    },
    event(kind, payload) {
      held.push({ runId, ts: engine.now().toISOString(), step, kind, payload });
      if (runId) flush();
    },
  };
  held.push({ runId: null, ts: started.toISOString(), step, kind: 'tool.start', payload: { input } });
  try {
    const result = await fn(call);
    call.event('tool.end', { duration_ms: engine.now().getTime() - started.getTime() });
    flush();
    return result;
  } catch (err) {
    call.event('tool.error', errorPayload(err));
    flush();
    throw err;
  }
}
