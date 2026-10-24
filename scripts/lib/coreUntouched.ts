// The pure core of the "no core changes" allowlist (M10 task, D15, D57, INV-27).
// It takes the path changes between a base ref and HEAD plus the raw case,
// pack, numstat and ratchet data scripts/check-core-untouched.ts reads from git,
// and returns the violations for a pack PR. Every decision lives in a pure
// function here (not in the git wrapper) so a fixture test can feed synthetic
// data, mirroring eval/addOnly.ts. Outside the engine (INV-40); src/ never
// imports it.
//
// This check is an allowlist: on a pack PR (one that changes anything under
// packs/ or knowledge/, D15) every changed path must fall inside the list the
// plan's "No core changes" definition describes, or the PR fails. It runs
// alongside scripts/check-eval-add-only.ts, which enforces the universal
// add-only rule for existing cases and runs (INV-45); this one enforces the
// pack-PR-specific rules (own-pack cases/completions/runs only, pinned case
// fields frozen, one added adapter file and one registry line, knowledge under
// the owned pack's libraries, README and history add-only, ratchet).

import { caseOf, runSetKey, type ChangeKind, type PathChange } from '../../eval/addOnly.js';

export type { ChangeKind, PathChange };

/** The pinned fields of a case.json that a completion may never change (D15). */
export const PINNED_CASE_FIELDS = [
  'id',
  'pack',
  'repo_url',
  'base_commit',
  'merge_commit',
  'pr_url',
  'source',
  'target',
  'tags',
  'license',
] as const;

/** The only case.json fields a completion may move (D15); every other key is frozen. */
export const COMPLETION_MUTABLE_FIELDS = ['notes', 'checks'] as const;

/** The usage-adapter registry file; a new adapter is registered by one added line here (D57). */
export const REGISTRY_FILE = 'src/analysis/usages/registry.ts';

// ---------------------------------------------------------------------------
// Pure derivations (unit-tested directly; the git wrapper only supplies inputs).
// ---------------------------------------------------------------------------

/** A pack PR changes anything under packs/ or knowledge/ (D15). */
export function isPackPR(changes: readonly PathChange[]): boolean {
  return changes.some((c) => /^(packs|knowledge)\//.test(c.path));
}

/** The <pack> dirs this PR changes under packs/. */
export function ownedPacks(changes: readonly PathChange[]): Set<string> {
  const packs = new Set<string>();
  for (const c of changes) {
    const m = c.path.match(/^packs\/([^/]+)\//);
    if (m) packs.add(m[1]!);
  }
  return packs;
}

/** The case id a run or case path belongs to, or null. */
export function caseIdOf(path: string): string | null {
  const c = caseOf(path);
  if (c) return c;
  const set = runSetKey(path);
  return set ? set.case : null;
}

/** git numstat counts a one-line edit as one added and one removed line, so the
 * size of a change is the larger of the two. A single-line registration is 1. */
export function numstatChangedLines(added: number, removed: number): number {
  if (!Number.isFinite(added) || !Number.isFinite(removed)) return Number.POSITIVE_INFINITY;
  return Math.max(added, removed);
}

/** Pinned fields that differ between two case.json objects (stable comparison). */
export function pinnedDiff(baseCase: Record<string, unknown> | null, headCase: Record<string, unknown> | null): string[] {
  if (!baseCase || !headCase) return [];
  return PINNED_CASE_FIELDS.filter((f) => JSON.stringify(baseCase[f]) !== JSON.stringify(headCase[f]));
}

/** Keys other than notes/checks that differ between two case.json objects (a completion may move only notes/checks). */
export function nonMutableKeysChanged(baseCase: Record<string, unknown> | null, headCase: Record<string, unknown> | null): string[] {
  if (!baseCase || !headCase) return [];
  const mutable = new Set<string>(COMPLETION_MUTABLE_FIELDS);
  const keys = new Set([...Object.keys(baseCase), ...Object.keys(headCase)]);
  return [...keys].filter((k) => !mutable.has(k) && JSON.stringify(baseCase[k]) !== JSON.stringify(headCase[k])).sort();
}

/** The knowledge path prefix for a library id `<ecosystem>/<library>` (e.g. npm/next -> knowledge/npm/next/). */
export function knowledgePrefix(libraryId: string): string {
  return `knowledge/${libraryId}/`;
}

export interface CaseMeta {
  /** The `pack` field of the case's case.json, or null when it can't be read (fail closed). */
  pack: string | null;
  /** True when the case had recorded runs on the base branch (an existing case). */
  hadRuns: boolean;
  /** True when a case.json existed for this case on the base branch. */
  existedOnBase: boolean;
  /** True when a case.json exists for this case at HEAD. */
  existsAtHead: boolean;
}

export interface CoreUntouchedInput {
  /** Every changed path between the base ref and HEAD, repo-relative, forward slashes. */
  changes: readonly PathChange[];
  /** The pack(s) this PR owns (from ownedPacks); the check requires exactly one. */
  ownPacks: ReadonlySet<string>;
  /** The library ids (`<ecosystem>/<library>`) the owned pack's pack.json names at HEAD. */
  ownPackLibraries: ReadonlySet<string>;
  /** The seeded repo name(s) the owned pack's pack.json names (`seeded` field). */
  ownSeededRepos: ReadonlySet<string>;
  /** Per touched case id, its pack and base/HEAD state. */
  caseMeta: ReadonlyMap<string, CaseMeta>;
  /** Case ids whose case.json this PR deletes. */
  casesRemoved: ReadonlySet<string>;
  /** Case ids this PR completes (own-pack, no base runs, case.json modified), with the fields that moved. */
  completions: ReadonlyMap<string, { pinnedChanged: readonly string[]; otherChanged: readonly string[] }>;
  /** True when any existing line of eval/cases/README.md was edited or removed (only added lines are allowed). */
  readmeExistingLineTouched: boolean;
  /** Ratchet entries added by this PR whose value does not equal the measured recall (free-text reasons). */
  ratchetBadNewEntries: readonly string[];
  /** True when the PR changes a ratchet entry present on the base branch (another pack's floor is frozen in M10, D57). */
  ratchetExistingEntryChanged: boolean;
  /** Changed-line count for src/analysis/usages/registry.ts (one added line registers an adapter). */
  registryChangedLines: number;
  /** Number of new adapter files added under src/analysis/usages/ (exactly one allowed, excluding index.ts and registry.ts). */
  newAdapterFiles: readonly string[];
}

/**
 * Whether a path is inside an allowed area for a pack PR, given the owned pack
 * and its libraries. This is intentionally tight: each eval and src area has a
 * stricter rule below, but the area gate itself rejects scoring code, another
 * pack's folders, another pack's seeded repo, and engine files.
 */
export function inAllowedArea(
  p: string,
  ownPacks: ReadonlySet<string>,
  ownPackLibraries: ReadonlySet<string>,
  ownSeededRepos: ReadonlySet<string>,
): boolean {
  // The owned pack's own pack folder (never another pack's).
  const packM = p.match(/^packs\/([^/]+)\//);
  if (packM) return ownPacks.has(packM[1]!);
  // Knowledge only under a library the owned pack's pack.json names.
  if (/^knowledge\//.test(p)) return [...ownPackLibraries].some((lib) => p.startsWith(knowledgePrefix(lib)));
  // The usage registry line, and one new adapter file. No other src/ change,
  // and never the shared adapter.ts/index.ts or an existing adapter file
  // (those are checked by the new-adapter-files rule below).
  if (p === REGISTRY_FILE) return true;
  if (/^src\/analysis\/usages\/[^/]+\.ts$/.test(p) && p !== 'src/analysis/usages/index.ts' && p !== REGISTRY_FILE) return true;
  // Eval data. The scoring code under eval/ is NOT allowed: only the data.
  if (/^eval\/cases\//.test(p)) return true; // own-pack + add-only rules below
  if (/^eval\/runs\//.test(p)) return true; // own-pack + add-only rules below
  if (p === 'eval/cases/README.md') return true;
  if (p === 'eval/cases/coverage-gaps.json') return true; // the pending-cases matrix (D15)
  if (p === 'eval/cases/REMOVED.json') return true; // add-only enforced by check-eval-add-only
  if (p === 'eval/results.md') return true;
  if (/^eval\/history\//.test(p)) return true; // add-only rule below
  // Seeded: only the regenerated recall.md, the ratchet, and the owned pack's own seeded repo.
  if (p === 'eval/seeded/recall.md') return true;
  if (p === 'eval/seeded/ratchet.json') return true;
  const seededM = p.match(/^eval\/seeded\/([^/]+)\//);
  if (seededM) return ownSeededRepos.has(seededM[1]!); // only the owned pack's declared seeded repo
  // The adapter's tests and fixtures: added files only (the add-only rule below).
  if (/^test\//.test(p)) return true;
  // Docs.
  if (/^docs\//.test(p)) return true;
  if (p === 'README.md') return true;
  // The regenerated plugin bundle.
  if (/^plugin\//.test(p)) return true;
  return false;
}

export function checkCoreUntouched(input: CoreUntouchedInput): string[] {
  const problems: string[] = [];

  // 0. Exactly one owned pack. More than one, or none in a pack PR, is refused.
  if (input.ownPacks.size !== 1) {
    problems.push(`a pack PR must own exactly one pack, found ${input.ownPacks.size ? [...input.ownPacks].join(', ') : 'none under packs/'} (each pack is its own PR)`);
  }

  // 1. Every changed path must be in an allowed area. Anything else is a core change.
  for (const c of input.changes) {
    if (!inAllowedArea(c.path, input.ownPacks, input.ownPackLibraries, input.ownSeededRepos)) {
      problems.push(`core file changed: ${c.kind} ${c.path} (outside the pack allowlist; a core change belongs in its own reviewed PR)`);
    }
  }

  // 2. The usage registry allows exactly one changed line; exactly one new adapter file, never an edit to an existing one.
  if (input.registryChangedLines > 1) {
    problems.push(`${REGISTRY_FILE} changed ${input.registryChangedLines} lines (a pack adds exactly one registry line)`);
  }
  if (input.newAdapterFiles.length > 1) {
    problems.push(`more than one new usage adapter added (${input.newAdapterFiles.join(', ')}); a pack adds exactly one`);
  }
  for (const c of input.changes) {
    // An edit or delete of an existing adapter file (not the one new file) is a core change.
    if (/^src\/analysis\/usages\/[^/]+\.ts$/.test(c.path) && c.path !== 'src/analysis/usages/index.ts' && c.path !== REGISTRY_FILE && c.kind !== 'added') {
      problems.push(`existing usage adapter changed: ${c.kind} ${c.path} (a pack adds one new adapter file, it never edits engine adapters)`);
    }
  }

  // 3. Eval cases and runs may only concern the PR's own pack; an unreadable case fails closed.
  for (const c of input.changes) {
    const id = caseIdOf(c.path);
    if (!id) continue;
    const meta = input.caseMeta.get(id);
    const isCasePath = caseOf(c.path) !== null;
    const label = isCasePath ? 'case' : 'run for case';
    if (!meta || meta.pack === null) {
      problems.push(`${label} ${id}: ${c.path} has no readable case.json (a pack PR touches only its own pack's cases; unknown cases are refused)`);
    } else if (!input.ownPacks.has(meta.pack)) {
      problems.push(`${label} ${id} belongs to pack ${meta.pack}, not this PR's pack(s) ${[...input.ownPacks].join(', ')} (a pack PR touches only its own pack's cases)`);
    }
  }

  // 4. A pack PR may never delete a case folder (pending or not). Removal is D15 exception (b), a core PR.
  for (const id of input.casesRemoved) {
    const meta = input.caseMeta.get(id);
    const owned = meta?.pack != null && input.ownPacks.has(meta.pack);
    problems.push(`case ${id} folder deleted (a pack PR may never remove a case, ${owned ? "its own pack's" : "another pack's"}; use D15 exception (b) in a core PR)`);
  }

  // 4b. Deleting a file from a case folder (other than the whole-case removal in 4) is never
  //     allowed: an existing case is frozen (add-only, INV-45), and a pending case is only
  //     added to/completed, never trimmed. (Round-1 noticed: pending-case non-case.json delete.)
  for (const c of input.changes) {
    if (c.kind !== 'deleted') continue;
    const id = caseOf(c.path);
    if (id && !input.casesRemoved.has(id)) {
      problems.push(`case ${id}: deleted ${c.path} (a case folder's files are never deleted; a pending case is only completed, an existing one is frozen)`);
    }
  }

  // 5. A completion may change only notes/checks: pinned and every other field stay byte-identical.
  for (const [id, { pinnedChanged, otherChanged }] of input.completions) {
    if (pinnedChanged.length > 0) {
      problems.push(`completed case ${id} changed pinned field(s) ${pinnedChanged.join(', ')} (a completion changes only notes and checks)`);
    }
    const nonPinnedOther = otherChanged.filter((k) => !PINNED_CASE_FIELDS.includes(k as (typeof PINNED_CASE_FIELDS)[number]));
    if (nonPinnedOther.length > 0) {
      problems.push(`completed case ${id} changed field(s) ${nonPinnedOther.join(', ')} outside notes/checks (a completion changes only notes and checks)`);
    }
  }

  // 6a. eval/history/: files may only be added, never changed or deleted (D15).
  for (const c of input.changes) {
    if (/^eval\/history\//.test(c.path) && c.kind !== 'added') {
      problems.push(`eval/history/: ${c.kind} ${c.path} (history files are add-only; a run only appends a history file)`);
    }
  }

  // 6b. eval/cases/README.md: only added lines (existing lines are frozen).
  if (input.readmeExistingLineTouched) {
    problems.push('eval/cases/README.md: an existing line was edited or removed (the coverage matrix is add-only, one new line per new case)');
  }

  // 7. The seeded ratchet: a new entry must equal the measured recall, and an entry on the base branch may not change.
  for (const reason of input.ratchetBadNewEntries) {
    problems.push(`eval/seeded/ratchet.json: ${reason}`);
  }
  if (input.ratchetExistingEntryChanged) {
    problems.push("eval/seeded/ratchet.json: an existing ratchet entry was changed (a floor on the base branch is frozen; a new pack only adds its own entry)");
  }

  // De-duplicate while keeping order.
  return [...new Set(problems)];
}
