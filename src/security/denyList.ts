// C4: files the engine never reads, whatever asks for them. The defaults can't
// be removed; user entries (the AGENTS.md snippet, M10) can only add.
import type { SafePath } from './pathBoundary.js';

const userEntries: RegExp[] = [];
const userGlobs: string[] = [];

/**
 * Why a snippet glob cannot be added. `!` would un-deny (gitignore negation).
 * An absolute path or a `..` segment points outside the repo root. Null means
 * the glob only adds a denial.
 */
export function denyGlobRejection(glob: string): string | null {
  const g = glob.trim();
  if (g === '') return 'empty deny entry';
  if (g.startsWith('!')) return 'a deny entry cannot remove a denial';
  if (g.startsWith('/') || g.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(g)) return 'path is outside the repo root';
  if (g.split(/[\\/]+/).some((seg) => seg === '..')) return 'path is outside the repo root';
  return null;
}

/** The globs actually added. A rejected glob is never in this list. */
export function userDenyGlobs(): readonly string[] {
  return userGlobs;
}

/**
 * Adds user deny entries. A trailing `/` denies a directory and everything in it,
 * `*` matches within one path segment and `**` across segments. There is no way
 * to remove an entry. A glob that would un-deny or point outside the root is
 * rejected and not added (INV-5).
 */
export function addUserDenies(entries: readonly string[]): { added: string[]; rejected: { glob: string; reason: string }[] } {
  const added: string[] = [];
  const rejected: { glob: string; reason: string }[] = [];
  for (const entry of entries) {
    const reason = denyGlobRejection(entry);
    if (reason) {
      rejected.push({ glob: entry, reason });
      continue;
    }
    userGlobs.push(entry);
    userEntries.push(globToRegExp(entry));
    added.push(entry);
  }
  return { added, rejected };
}

function globToRegExp(glob: string): RegExp {
  const dir = glob.endsWith('/');
  const trimmed = glob.replace(/\/+$/, '').replace(/^\.\//, '');
  const body = trimmed
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  // A pattern without a slash matches a name in any folder, like .gitignore.
  const anywhere = !trimmed.includes('/') ? '(?:.*/)?' : '';
  return new RegExp(`^${anywhere}${body}${dir ? '(?:/.*)?' : ''}$`);
}

const virtualenvDirs = new Set(['.venv', 'venv', 'site-packages']);

/** The default rules, on a root-relative path with `/` separators. */
export function isDeniedRel(rel: string): boolean {
  if (rel === '') return false;
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? '';

  if (base.startsWith('.env')) return true;
  if (/\.(pem|key|p12)$/i.test(base)) return true;
  if (base.startsWith('id_rsa')) return true;
  if (base === '.npmrc' || base === '.pypirc') return true;

  const git = segs.indexOf('.git');
  if (git >= 0) {
    // Only HEAD and refs metadata may be read from git internals.
    const inner = segs.slice(git + 1);
    const allowed =
      (inner.length === 1 && (inner[0] === 'HEAD' || inner[0] === 'packed-refs')) ||
      (inner.length >= 1 && inner[0] === 'refs');
    if (!allowed) return true;
  }

  const nm = segs.indexOf('node_modules');
  if (nm >= 0 && !(base === 'package.json' && segs.length > nm + 1)) return true;

  if (segs.some((s) => virtualenvDirs.has(s))) return true;

  return userEntries.some((re) => re.test(rel));
}

/** Checks both the requested path and where it really points, so a symlink can't launder a denied file. */
export function isDenied(sp: SafePath): boolean {
  return isDeniedRel(sp.rel) || isDeniedRel(sp.requested);
}
