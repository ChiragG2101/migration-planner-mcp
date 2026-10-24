// The pure core of the "no core changes" allowlist (M10 task, D15, INV-27). It
// takes the path changes between a base ref and HEAD, plus the case metadata
// scripts/check-core-untouched.ts reads from git, and returns the violations
// for a pack PR. Kept pure so a fixture test can feed synthetic diffs, mirroring
// eval/addOnly.ts. Outside the engine (INV-40); src/ never imports it.
//
// This check is an allowlist: on a pack PR (one that changes anything under
// packs/ or knowledge/, D15) every changed path must fall inside the list the
// plan's "No core changes" definition describes, or the PR fails. It runs
// alongside scripts/check-eval-add-only.ts, which enforces the universal
// add-only rule for existing cases and runs (INV-45); this one enforces the
// pack-PR-specific rules (own-pack cases/completions/runs only, pinned case
// fields frozen, README add-only).

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

export interface CaseMeta {
  /** The `pack` field of the case's case.json, or null when it can't be read. */
  pack: string | null;
  /** True when the case had recorded runs on the base branch (an existing case). */
  hadRuns: boolean;
  /** True when a case.json existed for this case on the base branch. */
  existedOnBase: boolean;
}

export interface CoreUntouchedInput {
  /** Every changed path between the base ref and HEAD, repo-relative, forward slashes. */
  changes: readonly PathChange[];
  /** The pack(s) this PR owns: the set of <pack> dirs it changes under packs/. */
  ownPacks: ReadonlySet<string>;
  /**
   * Per case id touched by this PR, its pack and base-branch state. The pack is
   * read from HEAD's case.json when present, else the base's (so a deleted case
   * still resolves). A case with no readable case.json has pack `null`.
   */
  caseMeta: ReadonlyMap<string, CaseMeta>;
  /** Case ids whose case.json this PR deletes (a pending-case removal in a pack PR is forbidden). */
  casesRemoved: ReadonlySet<string>;
  /**
   * Case ids this PR completes: a case with a case.json on the base branch, no
   * recorded runs on the base branch, whose case.json changed. For each, the set
   * of pinned fields that differ between base and HEAD (empty when only notes/checks moved).
   */
  completions: ReadonlyMap<string, { pinnedChanged: readonly string[] }>;
  /** README.md (eval/cases) lines: true when any existing line was edited or removed (only added lines are allowed). */
  readmeExistingLineTouched: boolean;
  /** Ratchet entries added by this PR whose value does not equal the measured recall (entry id -> reason). */
  ratchetBadNewEntries: readonly string[];
  /** True when the PR changes a ratchet entry for a pack it does not own. */
  ratchetOtherPackChanged: boolean;
  /** Number of changed lines in src/analysis/usages/index.ts (the one registry line is the only allowance). */
  usagesIndexChangedLines: number;
}

/**
 * Paths a pack PR may touch, as glob-free prefixes/regexes. A path matches the
 * allowlist when any entry matches. Eval data, the registry line, tests, docs
 * and regenerated outputs each have their own stricter rule below; this list is
 * the structural "is this even an allowed area" gate.
 */
function inAllowedArea(p: string, ownPacks: ReadonlySet<string>): boolean {
  // The pack's own knowledge and pack folders. Any ecosystem/library under
  // knowledge/ is allowed (a pack brings its own library facts); packs/ is
  // restricted to the pack(s) this PR owns so it can't edit another pack.
  if (/^knowledge\//.test(p)) return true;
  if (/^packs\//.test(p)) {
    const m = p.match(/^packs\/([^/]+)\//);
    return m ? ownPacks.has(m[1]!) : false;
  }
  // One new usage adapter and its single registry line.
  if (/^src\/analysis\/usages\/[^/]+\.ts$/.test(p) && p !== 'src/analysis/usages/index.ts') return true;
  if (p === 'src/analysis/usages/index.ts') return true; // line count checked separately
  // Eval data (cases, runs, the coverage matrix, the seeded repo, the ratchet,
  // regenerated results and history). Add-only and own-pack rules checked below.
  if (/^eval\/cases\//.test(p)) return true;
  if (/^eval\/runs\//.test(p)) return true;
  if (p === 'eval/cases/README.md') return true;
  if (p === 'eval/cases/coverage-gaps.json') return true;
  if (p === 'eval/cases/REMOVED.json') return true;
  if (/^eval\/seeded\//.test(p)) return true;
  if (p === 'eval/results.md') return true;
  if (/^eval\/history\//.test(p)) return true;
  // The adapter's tests and fixtures.
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

  // 1. Every changed path must be in an allowed area. Anything else is a core change.
  for (const c of input.changes) {
    if (!inAllowedArea(c.path, input.ownPacks)) {
      problems.push(`core file changed: ${c.kind} ${c.path} (outside the pack allowlist; a core change belongs in its own reviewed PR)`);
    }
  }

  // 2. The usage registry allows exactly one changed line (one new registration).
  if (input.changes.some((c) => c.path === 'src/analysis/usages/index.ts') && input.usagesIndexChangedLines > 1) {
    problems.push(`src/analysis/usages/index.ts changed ${input.usagesIndexChangedLines} lines (a pack adds exactly one registry line)`);
  }

  // 3. Eval cases and runs may only concern the PR's own pack.
  for (const c of input.changes) {
    const caseId = caseOf(c.path);
    if (caseId) {
      const meta = input.caseMeta.get(caseId);
      const pack = meta?.pack ?? null;
      if (pack !== null && !input.ownPacks.has(pack)) {
        problems.push(`case ${caseId} belongs to pack ${pack}, not this PR's pack(s) ${[...input.ownPacks].join(', ')} (a pack PR touches only its own pack's cases)`);
      }
    }
    const set = runSetKey(c.path);
    if (set) {
      const meta = input.caseMeta.get(set.case);
      const pack = meta?.pack ?? null;
      if (pack !== null && !input.ownPacks.has(pack)) {
        problems.push(`run for case ${set.case} belongs to pack ${pack}, not this PR's pack(s) (a pack PR records runs only for its own pack's cases)`);
      }
    }
  }

  // 4. A pack PR may never delete a case folder (pending or not). Removal of a
  //    case goes through D15 exception (b) in a core PR, checked by add-only.
  for (const id of input.casesRemoved) {
    const meta = input.caseMeta.get(id);
    const owned = meta?.pack !== null && meta?.pack !== undefined && input.ownPacks.has(meta.pack);
    const whose = owned ? "its own pack's" : "another pack's";
    problems.push(`case ${id} folder deleted (a pack PR may never remove a case, ${whose}; use D15 exception (b) in a core PR)`);
  }

  // 5. A completion may change only notes/checks: the pinned fields stay byte-identical.
  for (const [id, { pinnedChanged }] of input.completions) {
    if (pinnedChanged.length > 0) {
      problems.push(`completed case ${id} changed pinned field(s) ${pinnedChanged.join(', ')} (a completion changes only notes and checks)`);
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

  // 7. The seeded ratchet: a new entry must equal the measured recall, and another pack's entry may not change.
  for (const reason of input.ratchetBadNewEntries) {
    problems.push(`eval/seeded/ratchet.json: ${reason}`);
  }
  if (input.ratchetOtherPackChanged) {
    problems.push("eval/seeded/ratchet.json: a ratchet entry for a pack this PR does not own was changed (another pack's floor is frozen)");
  }

  // De-duplicate while keeping order.
  return [...new Set(problems)];
}
