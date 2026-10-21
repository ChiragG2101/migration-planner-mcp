// C3: the only module that writes files. Writes land under `--out`, never
// inside a registered repo root, and each write declares the level it needs.
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PermissionError } from './errors.js';
import { assertLevel, type Level } from './level.js';
import { isWithin, realpathAllowMissing, resolveInside, type SafePath } from './pathBoundary.js';

const repoRoots = new Set<string>();

/** Records a repo root (realpathed). Writes and output folders inside it are refused from then on. */
export function registerRepoRoot(root: string): void {
  repoRoots.add(realpathAllowMissing(root));
}

/**
 * The top of the outermost git working tree that contains `root` (a folder
 * holding a `.git` folder or file), or `root` itself when none does. Only
 * checks that `.git` exists; nothing is read. Outermost, so a submodule or a
 * repo cloned inside another repo still maps to the outer tree (D24).
 */
export function enclosingRepoTop(root: string): string {
  let top = realpathAllowMissing(root);
  for (let dir = top; ; dir = path.dirname(dir)) {
    try {
      lstatSync(path.join(dir, '.git'));
      top = dir;
    } catch {
      // No .git here; keep looking upward.
    }
    if (path.dirname(dir) === dir) return top;
  }
}

/** Throws when `p` resolves inside a registered repo root. `what` names the flag in the message. */
export function assertOutsideRepos(p: string, what: string): void {
  const real = realpathAllowMissing(p);
  for (const root of repoRoots) {
    if (isWithin(root, real)) {
      throw new PermissionError('out_inside_repo', `${what} resolves inside the repo (${root}); choose a folder outside it`, {
        path: real,
        repo: root,
      });
    }
  }
}

export interface OutWriter {
  /** Realpath of the output folder. */
  readonly root: string;
  writeFile(rel: string, data: string | Uint8Array, opts: { level: Level }): SafePath;
  mkdir(rel: string, opts: { level: Level }): SafePath;
}

function target(root: string, rel: string): SafePath {
  let sp: SafePath;
  try {
    sp = resolveInside(root, rel);
  } catch (err) {
    if (err instanceof PermissionError && err.code === 'outside_root') {
      throw new PermissionError('write_outside_out', `write outside the output folder refused: ${rel}`, { path: rel });
    }
    throw err;
  }
  for (const repo of repoRoots) {
    if (isWithin(repo, sp.abs)) {
      throw new PermissionError('write_inside_repo', `write inside the repo refused: ${rel}`, { path: rel, repo });
    }
  }
  return sp;
}

// ---------------------------------------------------------------------------
// Sandbox-specific helpers (M8). These write inside the sandbox subtree under
// --out. They bypass the level check (the sandbox is already inside --out,
// and the level check is in exec.ts). They still refuse writes inside a repo.
// ---------------------------------------------------------------------------

/** Write a file inside the sandbox (under --out). Refuses if the path resolves inside a repo. */
export function writeFileSandbox(abs: string, data: string | Uint8Array): void {
  for (const repo of repoRoots) {
    if (isWithin(repo, realpathAllowMissing(abs))) {
      throw new PermissionError('write_inside_repo', `write inside the repo refused: ${abs}`, { path: abs, repo });
    }
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

/** Create a directory inside the sandbox. Refuses if the path resolves inside a repo. */
export function mkdirSandbox(abs: string): void {
  for (const repo of repoRoots) {
    if (isWithin(repo, realpathAllowMissing(abs))) {
      throw new PermissionError('write_inside_repo', `mkdir inside the repo refused: ${abs}`, { path: abs, repo });
    }
  }
  mkdirSync(abs, { recursive: true });
}

/** Create a temp directory (mkdtemp) for use by exec.ts's env scrubbing. Never inside a repo. */
export function mkdtempSandbox(prefix: string): string {
  return mkdtempSync(prefix);
}

/** Remove a directory inside the sandbox. Refuses if the path resolves inside a repo. */
export function rmSandbox(abs: string): void {
  for (const repo of repoRoots) {
    if (isWithin(repo, realpathAllowMissing(abs))) {
      throw new PermissionError('write_inside_repo', `rm inside the repo refused: ${abs}`, { path: abs, repo });
    }
  }
  rmSync(abs, { recursive: true, force: true });
}

/** Creates the output folder (refused inside a registered repo) and returns its writer. */
export function openOutDir(outDir: string): OutWriter {
  assertOutsideRepos(outDir, '--out');
  mkdirSync(outDir, { recursive: true });
  const root = realpathAllowMissing(outDir);
  return {
    root,
    writeFile(rel, data, { level }) {
      assertLevel(level);
      const sp = target(root, rel);
      mkdirSync(path.dirname(sp.abs), { recursive: true });
      writeFileSync(sp.abs, data);
      return sp;
    },
    mkdir(rel, { level }) {
      assertLevel(level);
      const sp = target(root, rel);
      mkdirSync(sp.abs, { recursive: true });
      return sp;
    },
  };
}
