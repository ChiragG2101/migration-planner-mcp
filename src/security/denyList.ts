// C4: files the engine never reads, whatever asks for them. The defaults can't
// be removed; user entries (the AGENTS.md snippet, M10) can only add.
import type { SafePath } from './pathBoundary.js';

const userEntries: DenyGlob[] = [];
const userGlobs: string[] = [];
const userGlobSet = new Set<string>();

/**
 * A snippet glob longer than this is rejected and never compiled. 128 covers a
 * deep relative pattern. A longer string is not a useful deny glob. With the
 * matcher's tokens × path length cost, it also bounds each check (D58).
 */
export const MAX_USER_DENY_GLOB_LENGTH = 128;

/**
 * More than this many `**` is rejected. Two covers a prefix and a suffix, such
 * as src then generated. The matcher no longer backtracks on a chain of them,
 * but a deny glob has no use for more (D58).
 */
export const MAX_USER_DENY_DOUBLE_STARS = 2;

/**
 * How many slots one snippet has on each read. A glob added or already in the
 * list takes one, so repeat reads add no more. Further entries are rejected (D58).
 */
export const MAX_USER_DENY_ENTRIES = 32;

/**
 * Why a snippet glob cannot be added. `!` would un-deny (gitignore negation).
 * An absolute path or a `..` segment points outside the repo root. A glob that
 * is too long, or that has too many `**`, is rejected before it is compiled.
 * Null means the glob only adds a denial.
 */
export function denyGlobRejection(glob: string): string | null {
  const g = glob.trim();
  if (g === '') return 'empty deny entry';
  if (g.startsWith('!')) return 'a deny entry cannot remove a denial';
  if (g.startsWith('/') || g.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(g)) return 'path is outside the repo root';
  if (g.split(/[\\/]+/).some((seg) => seg === '..')) return 'path is outside the repo root';
  if (g.length > MAX_USER_DENY_GLOB_LENGTH) return `deny glob is longer than ${MAX_USER_DENY_GLOB_LENGTH} characters`;
  if (g.split('**').length - 1 > MAX_USER_DENY_DOUBLE_STARS) return `deny glob has more than ${MAX_USER_DENY_DOUBLE_STARS} "**"`;
  return null;
}

/** The globs actually added. A rejected glob is never in this list. */
export function userDenyGlobs(): readonly string[] {
  return userGlobs;
}

/**
 * Adds user deny entries. A trailing `/` denies a directory and everything in it,
 * `*` matches within one path segment and `**` across segments. There is no way
 * to remove an entry. A glob that would un-deny, point outside the root, or
 * break a limit is rejected and not added. Past the per-snippet cap, the
 * rest are rejected too. A glob already in the list is skipped, since every
 * ingest re-reads the snippet, but it still takes a slot, so one snippet adds
 * at most the cap however often it is read (INV-5, D58).
 */
export function addUserDenies(entries: readonly string[]): { added: string[]; rejected: { glob: string; reason: string }[] } {
  const added: string[] = [];
  const rejected: { glob: string; reason: string }[] = [];
  let slots = 0;
  for (const entry of entries) {
    if (slots >= MAX_USER_DENY_ENTRIES) {
      rejected.push({ glob: entry, reason: `planner_deny is limited to ${MAX_USER_DENY_ENTRIES} entries` });
      continue;
    }
    if (userGlobSet.has(entry)) {
      slots++;
      continue;
    }
    const reason = denyGlobRejection(entry);
    if (reason) {
      rejected.push({ glob: entry, reason });
      continue;
    }
    userGlobs.push(entry);
    userGlobSet.add(entry);
    userEntries.push(compileDenyGlob(entry));
    added.push(entry);
    slots++;
  }
  return { added, rejected };
}

/** `*` is a run without `/`, `**` any run. Everything else is a literal character. */
type GlobToken = string | 1 | 2;

export interface DenyGlob {
  readonly tokens: readonly GlobToken[];
  /** No `/` in the pattern, so it matches a name in any folder, like .gitignore. */
  readonly anywhere: boolean;
  /** A trailing `/`: the folder and everything in it. */
  readonly dir: boolean;
}

/** Same reading as the old regex: a trailing `/` marks a folder, one leading `./` is dropped, `**` is read left to right. */
export function compileDenyGlob(glob: string): DenyGlob {
  const dir = glob.endsWith('/');
  const trimmed = glob.replace(/\/+$/, '').replace(/^\.\//, '');
  const tokens: GlobToken[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '*') tokens.push(trimmed[i]!);
    else if (trimmed[i + 1] === '*') {
      tokens.push(2);
      i++;
    } else tokens.push(1);
  }
  return { tokens, anywhere: !trimmed.includes('/'), dir };
}

// The regex this replaces read `**` and the folder parts as `.`, which stops at
// a line break. Kept so the answers stay the same.
function isLineBreak(c: string): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

/**
 * One pass per token over the path, so the cost is at most tokens × path
 * length and never backtracks (D58). `reach[j]` is true when the tokens so far
 * can end just before `rel[j]`.
 */
export function matchDenyGlob(g: DenyGlob, rel: string): boolean {
  const n = rel.length;
  let firstBreak = n;
  let lastBreak = -1;
  for (let j = 0; j < n; j++) {
    if (isLineBreak(rel[j]!)) {
      if (firstBreak === n) firstBreak = j;
      lastBreak = j;
    }
  }
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  // The optional folder prefix: any start just after a `/` with no line break before it.
  if (g.anywhere) for (let j = 1; j <= Math.min(n, firstBreak + 1); j++) if (rel[j - 1] === '/') reach[j] = 1;
  let next = new Uint8Array(n + 1);
  for (const t of g.tokens) {
    next.fill(0);
    if (typeof t === 'string') {
      for (let j = 0; j < n; j++) if (reach[j] && rel[j] === t) next[j + 1] = 1;
    } else {
      for (let j = 0; j <= n; j++) {
        if (reach[j]) next[j] = 1;
        else if (j > 0 && next[j - 1]) {
          const c = rel[j - 1]!;
          if (t === 1 ? c !== '/' : !isLineBreak(c)) next[j] = 1;
        }
      }
    }
    [reach, next] = [next, reach];
  }
  if (reach[n]) return true;
  if (!g.dir) return false;
  // A folder entry also matches anything below it, again without a line break.
  for (let k = Math.max(0, lastBreak); k < n; k++) if (reach[k] && rel[k] === '/') return true;
  return false;
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

  return userEntries.some((g) => matchDenyGlob(g, rel));
}

/** Checks both the requested path and where it really points, so a symlink can't launder a denied file. */
export function isDenied(sp: SafePath): boolean {
  return isDeniedRel(sp.rel) || isDeniedRel(sp.requested);
}
