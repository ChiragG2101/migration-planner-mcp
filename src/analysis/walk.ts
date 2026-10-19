// The bounded walk of a repo for scan_repo, plus the repo-relative path
// helpers its results are used with. Every entry goes through the path
// boundary and the deny list; a refused entry is listed, never read.
import { createHash } from 'node:crypto';
import { PermissionError } from '../security/errors.js';
import { isDenied } from '../security/denyList.js';
import { resolveInside } from '../security/pathBoundary.js';
import { listDir, readBytes, statPath } from '../security/safeRead.js';
import type { Entrypoint, ScanLimits, Skipped } from '../schema/scan.js';

export const DEFAULT_LIMITS: ScanLimits = {
  max_files: 20_000,
  max_file_bytes: 8 * 1024 * 1024,
  max_total_bytes: 256 * 1024 * 1024,
};

export interface WalkedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Walk {
  files: WalkedFile[];
  skipped: Skipped[];
  bytes: number;
}

export const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Walks the repo. An entry the boundary rejects or the deny list matches is
 * skipped and listed (path only), never read; the walk carries on.
 */
export function walkRepo(root: string, repoId: string, limits: ScanLimits): Walk {
  const files: WalkedFile[] = [];
  const skipped: Skipped[] = [];
  const seenDirs = new Set<string>();
  let bytes = 0;

  const visit = (dirRel: string): void => {
    const dir = resolveInside(root, dirRel || '.', repoId);
    if (seenDirs.has(dir.abs)) return;
    seenDirs.add(dir.abs);
    const entries = listDir(dir).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const shown = entry.isDirectory() ? `${rel}/` : rel;
      let sp;
      try {
        sp = resolveInside(root, rel, repoId);
      } catch (err) {
        if (err instanceof PermissionError && err.code === 'outside_root') {
          skipped.push({ path: shown, reason: 'outside_root' });
          continue;
        }
        throw err;
      }
      if (isDenied(sp)) {
        skipped.push({ path: shown, reason: 'denied' });
        continue;
      }
      let st;
      try {
        st = statPath(sp);
      } catch {
        skipped.push({ path: shown, reason: 'unreadable' });
        continue;
      }
      if (st.isDirectory()) {
        visit(rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.length >= limits.max_files) {
        skipped.push({ path: rel, reason: 'max_files' });
      } else if (st.size > limits.max_file_bytes) {
        skipped.push({ path: rel, reason: 'too_large' });
      } else if (bytes + st.size > limits.max_total_bytes) {
        skipped.push({ path: rel, reason: 'max_total_bytes' });
      } else {
        const content = readBytes(sp);
        bytes += content.length;
        files.push({ path: rel, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
    }
  };

  visit('');
  return { files, skipped: skipped.sort((a, b) => byName(a.path, b.path)), bytes };
}

export const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
export const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
export const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);
export const isAncestorOrSelf = (dir: string, of: string): boolean => dir === '' || of === dir || of.startsWith(`${dir}/`);
export const shownDir = (dir: string): string => dir || '.';

export function sortEntrypoints(list: Entrypoint[]): Entrypoint[] {
  return list.sort((a, b) => byName(a.kind, b.kind) || byName(a.path ?? '', b.path ?? '') || byName(a.value ?? '', b.value ?? ''));
}
