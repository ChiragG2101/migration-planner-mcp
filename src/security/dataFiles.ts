// Reads the engine's own bundled data, `knowledge/` and `packs/` beside the
// package, never the user's repo (that goes through safeRead). Only JSON and
// Markdown are read: any other file is listed with no text, so the loader can
// refuse it (C9). A symlink is refused, so the data can't point outside its
// folder. v0.1 loads only the bundled data: a --rules-dir pointing anywhere
// else is refused.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotBuiltError, PermissionError } from './errors.js';
import { toPosix } from './pathBoundary.js';

/** The package root, from both src/security/ and dist/security/. */
export const BUNDLED_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

export type DataDir = 'knowledge' | 'packs';

export interface DataFile {
  /** Relative to the data root, with `/` separators: `knowledge/npm/next/library.json`. */
  readonly path: string;
  /** The file's text, or null for a file that is not .json or .md. */
  readonly text: string | null;
}

const dataFile = /\.(json|md)$/;

export function readDataTree(root: string, dir: DataDir): DataFile[] {
  const top = path.join(root, dir);
  const out: DataFile[] = [];
  const walk = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && abs === top) return;
      throw err;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(abs, e.name);
      const rel = toPosix(path.relative(root, child));
      if (lstatSync(child).isSymbolicLink()) throw new PermissionError('denied', `symlink in engine data refused: ${rel}`, { path: rel });
      if (e.isDirectory()) walk(child);
      else out.push({ path: rel, text: dataFile.test(e.name) ? readFileSync(child, 'utf8') : null });
    }
  };
  walk(top);
  return out;
}

export const THIRD_PARTY_MESSAGE = 'third-party packs not supported in v0.1';

/** A --rules-dir is accepted only when it is the bundled data itself. */
export function assertBundledRulesDir(dir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new NotBuiltError(THIRD_PARTY_MESSAGE);
  }
  const allowed = [BUNDLED_ROOT, path.join(BUNDLED_ROOT, 'knowledge'), path.join(BUNDLED_ROOT, 'packs')];
  if (!allowed.includes(real)) throw new NotBuiltError(THIRD_PARTY_MESSAGE);
}
