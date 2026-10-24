// The "no core changes" allowlist check for pack PRs (M10 task, D15, D57,
// INV-27). It compares HEAD's tree against a base ref and fails a pack PR on any
// change outside the allowlist the plan's "No core changes" definition
// describes. Runs alongside scripts/check-eval-add-only.ts (the universal
// add-only rule, INV-45) on every pack PR. Maintainer/CI tooling: it runs git,
// so it is outside the engine (INV-40) and is never imported by src/.
//
//   npm run check:core-untouched -- [--base <ref>]   (default base: BASE_SHA, else origin/main)
//
// A pack PR is one that changes anything under packs/ or knowledge/ (D15). On a
// core PR (nothing under those paths) this check does nothing. All of the
// decision logic lives in pure functions in scripts/lib/coreUntouched.ts, which
// test/unit/coreUntouched.test.ts drives directly; this wrapper only reads git.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkCoreUntouched,
  isPackPR,
  ownedPacks,
  caseIdOf,
  numstatChangedLines,
  pinnedDiff,
  nonMutableKeysChanged,
  REGISTRY_FILE,
  type CaseMeta,
  type ChangeKind,
  type CoreUntouchedInput,
  type PathChange,
} from './lib/coreUntouched.js';
import { runSetKey } from '../eval/addOnly.js';
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

/** True when a case.json exists at a ref. */
function caseExistsAt(ref: string, id: string): boolean {
  try {
    git('cat-file', '-e', `${ref}:eval/cases/${id}/case.json`);
    return true;
  } catch {
    return false;
  }
}

/** "<added>\t<removed>" numstat for one path; [added, removed], with Infinity for a binary change. */
function numstat(base: string, path: string): [number, number] {
  const out = git('diff', '--numstat', `${base}...HEAD`, '--', path).trim();
  if (!out) return [0, 0];
  const cols = out.split('\n')[0]!.split('\t');
  const added = cols[0] === '-' ? Number.POSITIVE_INFINITY : Number(cols[0]);
  const removed = cols[1] === '-' ? Number.POSITIVE_INFINITY : Number(cols[1]);
  return [added, removed];
}

type CaseJson = Record<string, unknown> & { pack?: string };
type PackJson = { libraries?: ({ id?: string } | string)[]; seeded?: string | string[] };

/** The library ids a pack.json names (`npm/next` from `{id}` or a bare string). */
function packLibraries(pack: PackJson | null): string[] {
  if (!pack?.libraries) return [];
  return pack.libraries.map((l) => (typeof l === 'string' ? l : l.id)).filter((id): id is string => typeof id === 'string');
}

async function main(argv: string[]): Promise<number> {
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1]! : process.env.BASE_SHA || 'origin/main';
  const changes = changesSince(base);

  if (!isPackPR(changes)) {
    process.stdout.write(`core-untouched check: not a pack PR, nothing to enforce (base ${base})\n`);
    return 0;
  }

  const ownPacks = ownedPacks(changes);

  // The owned pack's libraries and seeded repos, read from its HEAD pack.json
  // (only when exactly one pack is owned; the pure check refuses any other count).
  const ownPackLibraries = new Set<string>();
  const ownSeededRepos = new Set<string>();
  if (ownPacks.size === 1) {
    const pack = jsonAt<PackJson>('HEAD', `packs/${[...ownPacks][0]!}/pack.json`);
    for (const id of packLibraries(pack)) ownPackLibraries.add(id);
    const seeded = pack?.seeded;
    for (const s of Array.isArray(seeded) ? seeded : seeded ? [seeded] : []) ownSeededRepos.add(s);
  }

  const runsAtBase = casesWithRunsAt(base);

  // Per touched case: its pack (HEAD's case.json, else base's) and base/HEAD state.
  const touchedCases = new Set<string>();
  for (const c of changes) {
    const id = caseIdOf(c.path);
    if (id) touchedCases.add(id);
  }
  const caseMeta = new Map<string, CaseMeta>();
  const casesRemoved = new Set<string>();
  const completions = new Map<string, { pinnedChanged: readonly string[]; otherChanged: readonly string[] }>();
  for (const id of touchedCases) {
    const headCase = jsonAt<CaseJson>('HEAD', `eval/cases/${id}/case.json`);
    const baseCase = jsonAt<CaseJson>(base, `eval/cases/${id}/case.json`);
    const existedOnBase = caseExistsAt(base, id);
    const existsAtHead = caseExistsAt('HEAD', id);
    caseMeta.set(id, { pack: headCase?.pack ?? baseCase?.pack ?? null, hadRuns: runsAtBase.has(id), existedOnBase, existsAtHead });
    if (!existsAtHead && existedOnBase) casesRemoved.add(id);
    // A completion: case.json on base with no base runs, and it changed on HEAD.
    const caseJsonChanged = changes.some((c) => c.path === `eval/cases/${id}/case.json` && c.kind === 'modified');
    if (baseCase && headCase && !runsAtBase.has(id) && caseJsonChanged) {
      completions.set(id, { pinnedChanged: pinnedDiff(baseCase, headCase), otherChanged: nonMutableKeysChanged(baseCase, headCase) });
    }
  }

  // eval/cases/README.md: only added lines are allowed (removed lines flag an edit/deletion).
  const readmeChanged = changes.some((c) => c.path === 'eval/cases/README.md');
  const readmeExistingLineTouched = readmeChanged && numstat(base, 'eval/cases/README.md')[1] > 0;

  // The registry line count and the set of new adapter files.
  const registryChangedLines = changes.some((c) => c.path === REGISTRY_FILE)
    ? numstatChangedLines(...numstat(base, REGISTRY_FILE))
    : 0;
  const newAdapterFiles = changes
    .filter((c) => c.kind === 'added' && /^src\/analysis\/usages\/[^/]+\.ts$/.test(c.path) && c.path !== 'src/analysis/usages/index.ts' && c.path !== REGISTRY_FILE)
    .map((c) => c.path);

  // Ratchet: an entry on the base branch may not change; a new entry must equal the measured recall.
  const ratchetChanged = changes.some((c) => c.path === 'eval/seeded/ratchet.json');
  let ratchetExistingEntryChanged = false;
  const ratchetBadNewEntries: string[] = [];
  if (ratchetChanged) {
    const baseRatchet = jsonAt<Ratchet>(base, 'eval/seeded/ratchet.json') ?? {};
    const headRatchet = jsonAt<Ratchet>('HEAD', 'eval/seeded/ratchet.json') ?? {};
    for (const repo of Object.keys(baseRatchet)) {
      if (JSON.stringify(baseRatchet[repo]) !== JSON.stringify(headRatchet[repo])) ratchetExistingEntryChanged = true;
    }
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

  const input: CoreUntouchedInput = {
    changes,
    ownPacks,
    ownPackLibraries,
    ownSeededRepos,
    caseMeta,
    casesRemoved,
    completions,
    readmeExistingLineTouched,
    ratchetBadNewEntries,
    ratchetExistingEntryChanged,
    registryChangedLines,
    newAdapterFiles,
  };
  const problems = checkCoreUntouched(input);
  for (const p of problems) process.stderr.write(`FAIL ${p}\n`);
  if (problems.length === 0) process.stdout.write(`core-untouched check passed for pack ${[...ownPacks].join(', ')} (base ${base})\n`);
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
