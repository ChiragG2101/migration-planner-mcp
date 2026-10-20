// The pure core of the eval add-only check (M7 task 7, D15, INV-45). It takes
// the set of path changes between a base ref and HEAD, plus which cases had
// recorded runs on the base branch and whether the PR is a core or pack PR, and
// returns the violations. scripts/check-eval-add-only.ts supplies these from
// git. Kept pure so a fixture test can feed synthetic diffs. Outside the engine.

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface PathChange {
  path: string;
  kind: ChangeKind;
}

export interface AddOnlyInput {
  /** Every changed path between the base ref and HEAD, repo-relative with forward slashes. */
  changes: readonly PathChange[];
  /** Case ids that had recorded runs on the base branch (existing cases). */
  existingCases: ReadonlySet<string>;
  /** Run-set keys that existed on the base branch (see runSetKey). */
  existingRunSets: ReadonlySet<string>;
  /** A pack PR changes something under packs/ or knowledge/; a core PR does not (D15). */
  isPackPR: boolean;
  /** REMOVED.json entry ids added by this PR (new entries only). */
  removedAdded: ReadonlySet<string>;
  /** True when an existing REMOVED.json entry was edited or deleted. */
  removedEntriesTouched: boolean;
  /** Case ids whose case.json + runs this PR deletes entirely (a removal). */
  casesRemoved: ReadonlySet<string>;
  /** True when the PR changes eval/baseline/prompt.md. */
  baselinePromptChanged: boolean;
}

/** The run set a path belongs to, or null if it is not a run file. A set is a case's engine runs under one prompt version, its L1 set under that version, or its baseline folder (D15). */
export function runSetKey(path: string): { case: string; set: string } | null {
  // eval/runs/<case>/<promptVersion>/l1/<n>/...  (L1 set)
  let m = path.match(/^eval\/runs\/([^/]+)\/([^/]+)\/l1\/([^/]+)\//);
  if (m) return { case: m[1]!, set: `${m[2]}/l1` };
  // eval/runs/<case>/baseline/<n>/...
  m = path.match(/^eval\/runs\/([^/]+)\/(baseline)\/([^/]+)\//);
  if (m) return { case: m[1]!, set: 'baseline' };
  // eval/runs/<case>/<promptVersion>/<n>/...  (engine set)
  m = path.match(/^eval\/runs\/([^/]+)\/([^/]+)\/([^/]+)\//);
  if (m) return { case: m[1]!, set: m[2]! };
  return null;
}

/** The case id a path under eval/cases/<id>/ belongs to, or null. */
export function caseOf(path: string): string | null {
  const m = path.match(/^eval\/cases\/([^/]+)\//);
  return m ? m[1]! : null;
}

export function checkAddOnly(input: AddOnlyInput): string[] {
  const problems: string[] = [];

  for (const change of input.changes) {
    const p = change.path;

    // Case folders of an existing case are frozen, except annotations.json (append-only).
    const caseId = caseOf(p);
    if (caseId && input.existingCases.has(caseId) && !input.casesRemoved.has(caseId)) {
      const isAnnotations = p === `eval/cases/${caseId}/annotations.json`;
      if (!isAnnotations) {
        problems.push(`existing case ${caseId}: ${change.kind} ${p} (an existing case's files are frozen)`);
      }
    }

    // Recorded runs: a run set that existed on the base branch cannot gain, lose or change files.
    const set = runSetKey(p);
    if (set) {
      const key = `${set.case}/${set.set}`;
      const removingThisCase = input.casesRemoved.has(set.case);
      if (input.existingRunSets.has(key) && !removingThisCase) {
        problems.push(`existing run set ${key}: ${change.kind} ${p} (recorded runs are add-only; a set with runs on the base branch is frozen)`);
      }
    }
  }

  // Baseline-prompt exception (a): a core PR may change eval/baseline/prompt.md
  // and replace baseline runs, nothing else. It must not be a pack PR, and must
  // not edit an engine run or a case file.
  if (input.baselinePromptChanged) {
    if (input.isPackPR) problems.push('baseline prompt changed in a pack PR (exception (a) is a core PR only)');
    for (const change of input.changes) {
      const set = runSetKey(change.path);
      if (set && set.set !== 'baseline') problems.push(`baseline-prompt PR also touched engine/L1 run ${change.path} (exception (a) replaces only baseline runs)`);
      if (caseOf(change.path) && change.path !== 'eval/baseline/prompt.md') {
        // A case file change in a baseline-prompt PR is only allowed via other rules; flag case files.
        problems.push(`baseline-prompt PR also touched case file ${change.path} (exception (a) replaces only baseline runs)`);
      }
    }
  }

  // Removal exception (b): a case removed with all its runs, in a core PR, with a REMOVED.json entry.
  for (const id of input.casesRemoved) {
    if (input.isPackPR) problems.push(`case ${id} removed in a pack PR (removal is a core PR only, exception (b))`);
    if (!input.removedAdded.has(id)) problems.push(`case ${id} removed with no eval/cases/REMOVED.json entry`);
  }
  for (const id of input.removedAdded) {
    if (!input.casesRemoved.has(id)) problems.push(`REMOVED.json entry ${id} added with no matching case removal`);
  }
  if (input.removedEntriesTouched) problems.push('an existing REMOVED.json entry was edited or deleted (entries are frozen)');

  // A single run deleted without removing its whole case always fails.
  for (const change of input.changes) {
    if (change.kind !== 'deleted') continue;
    const set = runSetKey(change.path);
    if (set && !input.casesRemoved.has(set.case) && input.existingRunSets.has(`${set.case}/${set.set}`)) {
      problems.push(`deleted run file ${change.path} without removing its case ${set.case}`);
    }
  }

  // De-duplicate while keeping order.
  return [...new Set(problems)];
}
