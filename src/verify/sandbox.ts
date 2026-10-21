// Clone-based sandbox (M8, D43). Creates a git clone of the source repo under
// <out>/<run_id>/sandbox, with hooks disabled. The source repo is never written.
//
// The sandbox reflects HEAD, not uncommitted changes: before cloning, a dirty
// check reads the source tree (without writing its .git) and refuses a dirty
// tree so L1 always verifies a committed state (plan task 3).
import path from 'node:path';
import { execGit } from '../security/exec.js';
import { PermissionError } from '../security/errors.js';
import { assertLevel } from '../security/level.js';
import { resolveInside, isWithin, realpathAbs, type SafePath } from '../security/pathBoundary.js';
import { mkdirSandbox, rmSandbox } from '../security/safeWrite.js';
import { readdirSandbox } from '../security/safeRead.js';
import type { ExecResult } from '../schema/verify.js';

/** How many run sandboxes to keep before pruning the oldest (plan task 3). */
const KEEP_SANDBOXES = 5;

/** The fixed git identity the sandbox uses for its own stage commits. */
export const SANDBOX_GIT_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

export interface Sandbox {
  /** Absolute realpath of the sandbox root (the cloned repo). */
  readonly root: string;
  /** The commit SHA at the time of cloning. */
  readonly sourceHead: string;
  /** Resolve a path inside the sandbox. Throws PermissionError if it escapes. */
  resolve(rel: string): SafePath;
  /** The SafePath for the sandbox root itself (boundary = sandbox root). */
  readonly rootPath: SafePath;
}

/**
 * Reads the source tree's dirty state without writing its `.git`
 * (`--no-optional-locks` stops git refreshing the index). Returns the porcelain
 * output: empty means clean. The source repo is never modified.
 */
export function sourceDirty(repoRoot: string, outRoot: string): string {
  assertLevel(1);
  const repoReal = realpathAbs(repoRoot);
  const outReal = realpathAbs(outRoot);
  const outSafe = resolveInside(outReal, '.', null);
  const result = execGit(
    [
      'git',
      '--no-optional-locks',
      '--git-dir',
      path.join(repoReal, '.git'),
      '--work-tree',
      repoReal,
      'status',
      '--porcelain',
    ],
    outSafe,
    outReal,
    30_000,
  );
  return result.stdout.trim();
}

/**
 * Clone `repoRoot` into `<outRoot>/<runId>/sandbox` and return a Sandbox.
 * Requires level 1 (C5). Refuses a dirty source tree. Uses --no-hardlinks so
 * the source files are not shared with the sandbox.
 */
export function createSandbox(repoRoot: string, outRoot: string, runId: string): Sandbox {
  assertLevel(1);

  const repoReal = realpathAbs(repoRoot);
  const outReal = realpathAbs(outRoot);
  if (isWithin(repoReal, outReal)) {
    throw new PermissionError('sandbox_inside_repo', `output dir is inside the repo — cannot create sandbox`, {
      outRoot,
      repoRoot,
    });
  }

  // The sandbox reflects HEAD, not uncommitted changes (plan task 3).
  const dirty = sourceDirty(repoReal, outReal);
  if (dirty.length > 0) {
    throw new PermissionError('dirty_tree', 'commit or stash first: L1 verifies HEAD', {
      sample: dirty.split('\n').slice(0, 5),
    });
  }

  const sandboxDir = path.join(outReal, runId, 'sandbox');
  mkdirSandbox(path.dirname(sandboxDir));
  const outSafe = resolveInside(outReal, '.', null);

  // git clone --no-hardlinks --local <repo> <sandbox>
  const cloneResult = execGit(
    ['git', 'clone', '--no-hardlinks', '--local', repoReal, sandboxDir],
    outSafe,
    outReal,
    120_000,
  );
  if (cloneResult.exit_code !== 0) {
    throw new Error(`git clone failed (exit ${cloneResult.exit_code}): ${cloneResult.stderr}`);
  }

  const sandboxReal = realpathAbs(sandboxDir);
  const sandboxSafe = resolveInside(sandboxReal, '.', null);

  // Give the clone a fixed identity for its own stage commits (env, not config,
  // so no user .gitconfig is read; exec.ts passes these through).
  const sandbox: Sandbox = {
    root: sandboxReal,
    sourceHead: revParseHead(sandboxReal),
    rootPath: sandboxSafe,
    resolve: (rel: string) => resolveInside(sandboxReal, rel, null),
  };

  pruneOldSandboxes(outReal);
  return sandbox;
}

/** Reconstruct a Sandbox handle for an existing clone (no new clone). */
export function openSandbox(sandboxRoot: string, sourceHead: string): Sandbox {
  const sandboxReal = realpathAbs(sandboxRoot);
  return {
    root: sandboxReal,
    sourceHead,
    rootPath: resolveInside(sandboxReal, '.', null),
    resolve: (rel: string) => resolveInside(sandboxReal, rel, null),
  };
}

function revParseHead(sandboxReal: string): string {
  const sandboxSafe = resolveInside(sandboxReal, '.', null);
  const res = execGit(['git', 'rev-parse', 'HEAD'], sandboxSafe, sandboxReal, 10_000);
  return res.stdout.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Stage boundaries (plan task 6)
// ---------------------------------------------------------------------------

/** The scrubbed env extra for the sandbox's own commits: a fixed identity. */
export function sandboxCommitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: 'migration-planner',
    GIT_AUTHOR_EMAIL: 'bot@migration-planner.local',
    GIT_COMMITTER_NAME: 'migration-planner',
    GIT_COMMITTER_EMAIL: 'bot@migration-planner.local',
  };
}

/** Tag the current HEAD as the start of a stage (so a rollback returns here). */
export function tagStageStart(sandbox: Sandbox, stageId: string): void {
  assertLevel(1);
  // Delete any stale tag from a prior attempt, then re-tag HEAD.
  execGit(['git', 'tag', '-d', stageStartTag(stageId)], sandbox.rootPath, sandbox.root, 10_000);
  execGit(['git', 'tag', stageStartTag(stageId)], sandbox.rootPath, sandbox.root, 10_000);
}

export function stageStartTag(stageId: string): string {
  return `mp-stage-start-${stageId}`;
}

/** Reset the working tree and index to a stage's start tag. */
export function resetToStageStart(sandbox: Sandbox, stageId: string): ExecResult {
  assertLevel(1);
  return execGit(['git', 'reset', '--hard', stageStartTag(stageId)], sandbox.rootPath, sandbox.root, 30_000);
}

/** Remove the sandbox directory. Called on rollback of the whole run. */
export function destroySandbox(sandbox: Sandbox): void {
  rmSandbox(sandbox.root);
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** Keep the most recent KEEP_SANDBOXES run sandboxes under outRoot; remove older ones. */
function pruneOldSandboxes(outReal: string): void {
  // Run folders are <outRoot>/<runId>/sandbox. We prune by run folder mtime.
  const names = readdirSandbox(outReal).filter((n) => n !== 'store.sqlite' && !n.startsWith('.'));
  if (names.length <= KEEP_SANDBOXES) return;
  // Sort by name (run IDs are time-ordered ULIDs/UUIDv7 in practice); keep the newest.
  const sorted = [...names].sort();
  const toRemove = sorted.slice(0, sorted.length - KEEP_SANDBOXES);
  for (const name of toRemove) {
    const sandboxPath = path.join(outReal, name, 'sandbox');
    try {
      rmSandbox(sandboxPath);
    } catch {
      // Best-effort prune; a locked folder is left for the next run.
    }
  }
}
