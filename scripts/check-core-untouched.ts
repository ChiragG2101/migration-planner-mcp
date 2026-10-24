// The "no core changes" allowlist check for pack PRs (M10 task, D15, INV-27).
// It compares HEAD's tree against a base ref and fails a pack PR on any change
// outside the allowlist the plan's "No core changes" definition describes. Runs
// alongside scripts/check-eval-add-only.ts (the universal add-only rule, INV-45)
// on every pack PR. Maintainer/CI tooling: it runs git, so it is outside the
// engine (INV-40) and is never imported by src/.
//
//   npm run check:core-untouched -- [--base <ref>]   (default base: origin/main, else BASE_SHA)
//
// A pack PR is one that changes anything under packs/ or knowledge/ (D15). On a
// core PR (nothing under those paths) this check does nothing: the allowlist is
// about what a pack PR may touch, and core changes are reviewed on their own.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCoreUntouched, PINNED_CASE_FIELDS, type CaseMeta, type PathChange, type ChangeKind } from './lib/coreUntouched.js';
import { caseOf, runSetKey } from '../eval/addOnly.js';
import { measure, ratio, type Ratchet } from '../eval/seeded/recall.js';

function git(...args: string[]): string {
  // Swallow stderr: some probes (a file absent in a ref) throw and are handled here.
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

/** JSON of a path at a ref, or null when the path is absent there. */
function jsonAt<T>(ref: string, path: string): T | null {
  try {
    return JSON.parse(git('show', `${ref}:${path}`)) as T;
  } catch {
    return null;
  }
}

/** Case ids with at least one recorded run folder at a ref. */
function casesWithRunsAt(ref: string): Set<string> {
  const cases = new Set<string>();
  let listing: string;
  try {
    listing = git('ls-tree', '-r', '--name-only', ref, 'eval/runs/');
  } catch {
    return cases;
  }
  for (const p of listing.split('\n')) {
    const set = runSetKey(p.trim());
    if (set) cases.add(set.case);
  }
  return cases;
}

type CaseJson = Record<string, unknown> & { pack?: string };

/**
 * The size of the change to one path, as the larger of added and removed lines.
 * A one-line registration edits a single line, which git counts as one added and
 * one removed line, so a single-line edit is 1, and anything bigger (two added, a
 * second edited line) is 2 or more. This is the "exactly one registry line" rule.
 */
function changedLineCount(base: string, path: string): number {
  // --numstat prints "<added>\t<removed>\t<path>".
  const out = git('diff', '--numstat', `${base}...HEAD`, '--', path).trim();
  if (!out) return 0;
  const first = out.split('\n')[0]!.split('\t');
  const added = Number(first[0]);
  const removed = Number(first[1]);
  if (Number.isNaN(added) || Number.isNaN(removed)) return Number.POSITIVE_INFINITY; // binary ("-\t-")
  return Math.max(added, removed);
}

/** True when any existing line of a file was edited or removed between base and HEAD (only additions allowed). */
function existingLinesTouched(base: string, path: string): boolean {
  const out = git('diff', '--numstat', `${base}...HEAD`, '--', path).trim();
  if (!out) return false;
  const cols = out.split('\n')[0]!.split('\t');
  const removed = Number(cols[1]);
  return !Number.isNaN(removed) && removed > 0;
}

/** Pinned fields that differ between two case.json objects (JSON-stable comparison). */
function pinnedDiff(baseCase: CaseJson | null, headCase: CaseJson | null): string[] {
  if (!baseCase || !headCase) return [];
  const changed: string[] = [];
  for (const f of PINNED_CASE_FIELDS) {
    if (JSON.stringify(baseCase[f]) !== JSON.stringify(headCase[f])) changed.push(f);
  }
  return changed;
}

async function main(argv: string[]): Promise<number> {
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1]! : process.env.BASE_SHA || 'origin/main';
  const changes = changesSince(base);

  const isPackPR = changes.some((c) => /^(packs|knowledge)\//.test(c.path));
  if (!isPackPR) {
    process.stdout.write(`core-untouched check: not a pack PR, nothing to enforce (base ${base})\n`);
    return 0;
  }

  // The pack(s) this PR owns: every <pack> dir it changes under packs/.
  const ownPacks = new Set<string>();
  for (const c of changes) {
    const m = c.path.match(/^packs\/([^/]+)\//);
    if (m) ownPacks.add(m[1]!);
  }

  const runsAtBase = casesWithRunsAt(base);

  // Per touched case: its pack (HEAD's case.json, else base's) and base state.
  const touchedCases = new Set<string>();
  for (const c of changes) {
    const id = caseOf(c.path);
    if (id) touchedCases.add(id);
    const set = runSetKey(c.path);
    if (set) touchedCases.add(set.case);
  }
  const caseMeta = new Map<string, CaseMeta>();
  const casesRemoved = new Set<string>();
  const completions = new Map<string, { pinnedChanged: readonly string[] }>();
  for (const id of touchedCases) {
    const headCase = jsonAt<CaseJson>('HEAD', `eval/cases/${id}/case.json`);
    const baseCase = jsonAt<CaseJson>(base, `eval/cases/${id}/case.json`);
    caseMeta.set(id, {
      pack: headCase?.pack ?? baseCase?.pack ?? null,
      hadRuns: runsAtBase.has(id),
      existedOnBase: baseCase !== null,
    });
    if (!headCase && baseCase) casesRemoved.add(id);
    // A completion: case.json present on base with no runs on base, and it changed on HEAD.
    const caseJsonChanged = changes.some((c) => c.path === `eval/cases/${id}/case.json` && c.kind === 'modified');
    if (baseCase && headCase && !runsAtBase.has(id) && caseJsonChanged) {
      completions.set(id, { pinnedChanged: pinnedDiff(baseCase, headCase) });
    }
  }

  // eval/cases/README.md: only added lines are allowed.
  const readmeChanged = changes.some((c) => c.path === 'eval/cases/README.md');
  const readmeExistingLineTouched = readmeChanged && existingLinesTouched(base, 'eval/cases/README.md');

  // Registry line count.
  const usagesIndexChangedLines = changes.some((c) => c.path === 'src/analysis/usages/index.ts')
    ? changedLineCount(base, 'src/analysis/usages/index.ts')
    : 0;

  // Ratchet: another pack's entry may not change; a new entry must equal the measured recall.
  const ratchetChanged = changes.some((c) => c.path === 'eval/seeded/ratchet.json');
  let ratchetOtherPackChanged = false;
  const ratchetBadNewEntries: string[] = [];
  if (ratchetChanged) {
    const baseRatchet = jsonAt<Ratchet>(base, 'eval/seeded/ratchet.json') ?? {};
    const headRatchet = jsonAt<Ratchet>('HEAD', 'eval/seeded/ratchet.json') ?? {};
    // A ratchet entry's "pack" is its seeded repo name; a PR owns a repo entry
    // when it is a new entry this PR adds. Any change to an entry present on the
    // base branch is a change to an existing (hence another pack's) floor here,
    // since a pack PR never re-measures another pack's seeded repo.
    for (const repo of Object.keys(baseRatchet)) {
      if (JSON.stringify(baseRatchet[repo]) !== JSON.stringify(headRatchet[repo])) ratchetOtherPackChanged = true;
    }
    // New entries: measure their recall and require equality (INV-50 also checks this).
    for (const repo of Object.keys(headRatchet)) {
      if (repo in baseRatchet) continue;
      const floor = headRatchet[repo]?.overall;
      try {
        const measured = ratio((await measure(repo)).overall);
        if (floor === undefined || Math.abs(measured - floor) > 1e-9) {
          ratchetBadNewEntries.push(`new entry ${repo} is ${floor}, but the measured recall is ${measured.toFixed(4)}`);
        }
      } catch (err) {
        ratchetBadNewEntries.push(`new entry ${repo} could not be measured: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const problems = checkCoreUntouched({
    changes,
    ownPacks,
    caseMeta,
    casesRemoved,
    completions,
    readmeExistingLineTouched,
    ratchetBadNewEntries,
    ratchetOtherPackChanged,
    usagesIndexChangedLines,
  });
  for (const p of problems) process.stderr.write(`FAIL ${p}\n`);
  if (problems.length === 0) process.stdout.write(`core-untouched check passed for pack(s) ${[...ownPacks].join(', ')} (base ${base})\n`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
