// The read API. It takes only a SafePath from resolveInside and refuses
// deny-listed files, so no caller can read past the boundary or the deny list.
import { type Dirent, type Stats, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PermissionError } from './errors.js';
import { isDenied } from './denyList.js';
import { isSafePath, type SafePath } from './pathBoundary.js';

function check(sp: SafePath): void {
  if (!isSafePath(sp)) throw new PermissionError('forged_path', 'reads take only a SafePath from resolveInside');
  if (isDenied(sp)) throw new PermissionError('denied', `denied by the deny list: ${sp.requested}`, { path: sp.requested });
}

export function readBytes(sp: SafePath): Buffer {
  check(sp);
  return readFileSync(sp.abs);
}

export function readText(sp: SafePath): string {
  return readBytes(sp).toString('utf8');
}

export function statPath(sp: SafePath): Stats {
  check(sp);
  return statSync(sp.abs);
}

/** lstat of the requested path (not following a final symlink), for walking. */
export function lstatRequested(sp: SafePath): Stats {
  check(sp);
  return lstatSync(path.join(sp.root, sp.requested));
}

export function listDir(sp: SafePath): Dirent[] {
  check(sp);
  return readdirSync(sp.abs, { withFileTypes: true });
}
