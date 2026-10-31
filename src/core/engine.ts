// The engine context every core function runs in: the process level, where
// output goes, and the store. The output folder and store are opened only
// after the "not inside the repo" check passes, so a refused --out or --db
// never creates a file in the repo.
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS } from '../analysis/scanner.js';
import { PACKET_MAX_CHARS } from '../pipeline/packets.js';
import { describeBundle, loadBundled, type Bundle } from '../rules/loader.js';
import type { ScanLimits } from '../schema/scan.js';
import { InputError, NotBuiltError, PermissionError } from '../security/errors.js';
import { observeExec } from '../security/exec.js';
import { initLevel, type Level } from '../security/level.js';
import { isWithin, realpathAllowMissing } from '../security/pathBoundary.js';
import { assertOutsideRepos, enclosingRepoTop, openOutDir, registerRepoRoot, type OutWriter } from '../security/safeWrite.js';
import type { DocsTransport } from '../docs/context7.js';
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
  /**
   * Context7. A transport counts as configured. `apiKey: null` forces it off
   * even when CONTEXT7_API_KEY is set. Otherwise the env key is used.
   */
  docs?: {
    transport?: DocsTransport;
    apiKey?: string | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    freshForMs?: number;
    cacheMaxBytes?: number;
    protectRuns?: number;
  };
  /** Lens packet JSON stays within this many characters. Truncation is reported. */
  packetMaxChars?: number;
  /**
   * User-declared check commands, frozen at startup from CLI flags (D44, C9).
   * The AGENTS.md snippet can fill an empty set at ingest, and only with
   * `trustRepoChecks` (D58). Only used at level 1. Empty at level 0.
   */
  checks?: import('../schema/verify.js').CheckConfig[];
  /**
   * User-declared install commands, frozen at startup from CLI flags (D44, C9).
   * The snippet is the second source, under the same rule as `checks` (D58).
   */
  installs?: import('../schema/verify.js').InstallConfig[];
  /**
   * True when the process was started with `--install` or `--check`. Those
   * flags are the check config; the snippet cannot replace them (D58).
   */
  checksFromCli?: boolean;
  /**
   * Use the AGENTS.md snippet's checks when the CLI did not set any. A tool
   * argument cannot set this (D58, INV-8).
   */
  trustRepoChecks?: boolean;
  /**
   * Extra parent-env names the user allows the sandbox to inherit (--pass-env).
   * Never from a tool arg, pack, knowledge or the agent. Only used at level 1.
   */
  passEnv?: readonly string[];
  /**
   * Sandbox mode. Only the clone sandbox is built in v0.1; container mode was
   * cut (D42) and 'container' is refused with NotBuiltError (INV-63).
   */
  sandbox?: 'clone' | 'container';
  /**
   * Findings below this confidence go to "Needs human decision" (M9 routing).
   * Default 0.6 (DEFAULT_CONFIDENCE_THRESHOLD); the value and whether it came
   * from the flag are recorded per run at emit.
   */
  confidenceThreshold?: number;
  /**
   * The run budget (--budget-tokens, --budget-seconds). Once a run is over it,
   * the remaining lenses and stages are recorded as budget_cut, never skipped
   * silently (M9 task 5).
   */
  budget?: { tokens?: number; seconds?: number };
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
  /** Lens packets are cut to this size, and the cut is reported on the packet. */
  readonly packetMaxChars: number;
}

export function createEngine(options: EngineOptions = {}): Engine {
  // Container sandbox mode was cut for v0.1 (D42, INV-63). Refuse it here so
  // both the CLI and the MCP server reject it the same way.
  if (options.sandbox === 'container') {
    throw new NotBuiltError('container sandbox mode is not built in v0.1 (cut per D42); use the default clone sandbox');
  }
  const t = options.confidenceThreshold;
  if (t !== undefined && !(Number.isFinite(t) && t >= 0 && t <= 1)) {
    throw new InputError('bad_threshold', `the confidence threshold must be a number from 0 to 1, got ${String(t)}`);
  }
  for (const [name, v] of Object.entries(options.budget ?? {})) {
    if (v !== undefined && !(Number.isFinite(v) && v > 0)) throw new InputError('bad_budget', `the ${name} budget must be a positive number, got ${String(v)}`);
  }
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
    packetMaxChars: options.packetMaxChars ?? PACKET_MAX_CHARS,
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
  /** Records the tokens the host reported for this step (a `cost.reported` event carrying the token columns). */
  cost(tokensIn: number, tokensOut: number): void;
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
    cost(tokensIn, tokensOut) {
      held.push({ runId, ts: engine.now().toISOString(), step, kind: 'cost.reported', payload: { tokens_in: tokensIn, tokens_out: tokensOut }, tokensIn, tokensOut });
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

/**
 * Runs `fn` with every command the spawn point runs recorded as an `exec.run`
 * event on the call (kind, argv, exit code, duration), for the run report.
 */
export async function withExecLog<T>(call: ToolCall, fn: () => Promise<T>): Promise<T> {
  const stop = observeExec((r) => call.event('exec.run', r));
  try {
    return await fn();
  } finally {
    stop();
  }
}
