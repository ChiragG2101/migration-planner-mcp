// C4: every path the engine touches is resolved here. Both the root and the
// target are realpathed, so `..`, absolute paths and symlinks that leave the
// root are all rejected the same way.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PermissionError } from './errors.js';

declare const safePathBrand: unique symbol;

export interface SafePath {
  readonly [safePathBrand]: true;
  /** Realpath of the boundary root. */
  readonly root: string;
  /** Realpath of the target (for a target that doesn't exist yet: of its nearest existing ancestor, plus the rest). */
  readonly abs: string;
  /** `abs` relative to `root`, with `/` separators. `''` is the root itself. */
  readonly rel: string;
  /** The path as requested, relative to `root`, with `/` separators, before symlinks are followed. */
  readonly requested: string;
  /** The repo this path belongs to, or null for a non-repo root such as `--out`. */
  readonly repoId: string | null;
}

// Only objects made here are SafePaths; a lookalike built from JSON is refused by the read and write APIs.
const issued = new WeakSet<object>();

export function isSafePath(value: unknown): value is SafePath {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function escapes(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** Realpath of `p`, or of its nearest existing ancestor joined with the missing rest. */
export function realpathAllowMissing(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...rest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw err;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** True when `p` (realpathed) is `root` or under it. Both must already be realpaths. */
export function isWithin(root: string, p: string): boolean {
  return !escapes(path.relative(root, p));
}

/** True when a relative path's `..` segments climb above its start at any point, as in `../repo/x`. */
function climbsOut(p: string): boolean {
  if (path.isAbsolute(p)) return false;
  let depth = 0;
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === '..') depth -= 1;
    else if (seg !== '' && seg !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

export function resolveInside(root: string, p: string, repoId: string | null = null): SafePath {
  const rootReal = realpathSync.native(root);
  const candidate = path.resolve(rootReal, p);
  const lexicalRel = path.relative(rootReal, candidate);
  const abs = realpathAllowMissing(candidate);
  const rel = path.relative(rootReal, abs);
  if (climbsOut(p) || escapes(lexicalRel) || escapes(rel)) {
    throw new PermissionError('outside_root', `path is outside the root: ${p}`, { path: p });
  }
  const safe = Object.freeze({ root: rootReal, abs, rel: toPosix(rel), requested: toPosix(lexicalRel), repoId });
  issued.add(safe);
  return safe as unknown as SafePath;
}
