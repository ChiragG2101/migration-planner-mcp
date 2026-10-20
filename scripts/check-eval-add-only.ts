// Eval add-only check (M7 task 7, D15, INV-45). Compares HEAD's tree against a
// base ref and fails on any change that breaks the add-only rule for recorded
// cases and runs. Runs on every PR from M7. Maintainer/CI tooling: it runs git,
// so it is outside the engine (INV-40) and never imported by src/.
//
//   npm run eval:add-only -- [--base <ref>]   (default base: origin/main, else BASE_SHA)
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkAddOnly, caseOf, runSetKey, type ChangeKind, type PathChange } from '../eval/addOnly.js';

function git(...args: string[]): string {
  // Inherit stdin/stdout but swallow stderr: some callers probe for paths that
  // may be absent in a ref (e.g. REMOVED.json on a fresh branch) and handle the
  // throw themselves, so git's "fatal:" chatter would otherwise be misleading.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

const KIND: Record<string, ChangeKind> = { A: 'added', M: 'modified', D: 'deleted', R: 'modified', C: 'added', T: 'modified' };

/** Changed paths between base and HEAD. R/C lines carry two paths; both are reported. */
function changesSince(base: string): PathChange[] {
  const out = git('diff', '--name-status', '-M', `${base}...HEAD`);
  const changes: PathChange[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0]![0]!;
    const kind = KIND[status] ?? 'modified';
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      changes.push({ path: parts[1]!, kind: 'deleted' });
      changes.push({ path: parts[2]!, kind: 'added' });
    } else {
      changes.push({ path: parts[parts.length - 1]!, kind });
    }
  }
  return changes;
}

/** Case ids with at least one recorded run folder at the base ref. */
function casesWithRunsAt(ref: string): { cases: Set<string>; runSets: Set<string> } {
  const cases = new Set<string>();
  const runSets = new Set<string>();
  let listing: string;
  try {
    listing = git('ls-tree', '-r', '--name-only', ref, 'eval/runs/');
  } catch {
    return { cases, runSets };
  }
  for (const path of listing.split('\n')) {
    const set = runSetKey(path.trim());
    if (set) {
      cases.add(set.case);
      runSets.add(`${set.case}/${set.set}`);
    }
  }
  return { cases, runSets };
}

/** REMOVED.json ids at a ref (empty when the file is absent). */
function removedIdsAt(ref: string): Set<string> {
  try {
    const entries = JSON.parse(git('show', `${ref}:eval/cases/REMOVED.json`)) as { id: string }[];
    return new Set(entries.map((e) => e.id));
  } catch {
    return new Set();
  }
}

function main(argv: string[]): number {
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1]! : process.env.BASE_SHA || 'origin/main';
  const changes = changesSince(base);
  const { cases: existingCases, runSets: existingRunSets } = casesWithRunsAt(base);

  const isPackPR = changes.some((c) => /^(packs|knowledge)\//.test(c.path));

  // A removed case: its case.json was deleted and the case had runs on the base branch.
  const casesRemoved = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'deleted') {
      const id = caseOf(c.path);
      if (id && c.path === `eval/cases/${id}/case.json`) casesRemoved.add(id);
    }
  }
  // Also treat pending-case removals (no runs) as removals needing a REMOVED entry.
  const removedBase = removedIdsAt(base);
  const removedHead = removedIdsAt('HEAD');
  const removedAdded = new Set([...removedHead].filter((id) => !removedBase.has(id)));
  const removedEntriesTouched = [...removedBase].some((id) => !removedHead.has(id));
  const baselinePromptChanged = changes.some((c) => c.path === 'eval/baseline/prompt.md');

  const problems = checkAddOnly({
    changes,
    existingCases,
    existingRunSets,
    isPackPR,
    removedAdded,
    removedEntriesTouched,
    casesRemoved,
    baselinePromptChanged,
  });
  for (const p of problems) process.stderr.write(`FAIL ${p}\n`);
  if (problems.length === 0) process.stdout.write(`eval add-only check passed (base ${base})\n`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
