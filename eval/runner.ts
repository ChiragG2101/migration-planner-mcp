// The eval runner (M7 task 3). Replay is the default and the only free mode: it
// re-runs recorded engine runs through HEAD's engine with no model and no
// network (C1), and re-scores baseline runs from their Markdown. Generates
// eval/results.md (a pure function of HEAD's tree) and, with --check, fails if
// the committed results.md differs or the pack gate fails. Outside the engine
// (INV-40): it writes files and reads recorded runs.
//
//   npm run eval -- --tier all          regenerate eval/results.md
//   npm run eval -- --tier all --check  fail if results.md is stale or the pack gate fails
//   npm run eval:smoke                  the seeded tier plus one golden case (milestone gate)
//   npm run eval -- --case <id> | --pack <name>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundled } from '../src/rules/loader.js';
import { checkoutAtBase, workDir } from './caseCommits.js';
import { loadCases, loadBaselineRuns, loadEngineRuns, loadRemoved, evalRoot, type LoadedCase } from './load.js';
import type { CaseRunRecall } from './metrics.js';
import { packGate, type BaseBand, type Host, type PackRuns } from './packGate.js';
import { renderResults, type PackResult } from './results.js';
import { replayBaselineRun, replayEngineRun } from './replay.js';
import type { Truth } from './schema.js';

const resultsPath = (): string => path.join(evalRoot(), 'results.md');

/** The current prompt version named by prompts/manifest.json at HEAD. */
function currentPromptVersion(): string {
  const top = path.dirname(evalRoot());
  const manifest = JSON.parse(readFileSync(path.join(top, 'prompts', 'manifest.json'), 'utf8')) as { current: string };
  return manifest.current;
}

/** A code hash of the gate sources, recorded in results.md (D17). Pure function of HEAD's tree. */
function gatesHash(): string {
  const dir = path.join(path.dirname(evalRoot()), 'src', 'pipeline', 'gates');
  const files = ['g1-evidence.ts', 'g2-coverage.ts', 'g3-doc-refs.ts', 'g4-rollback-verify.ts', 'g5-stage-order.ts', 'g6-schema-ids.ts', 'index.ts'];
  const hash = createHash('sha256');
  for (const f of files) hash.update(readFileSync(path.join(dir, f)));
  return hash.digest('hex').slice(0, 12);
}

/** The set of packs that exist under packs/ at HEAD (from the loaded bundle). */
function packsAtHead(): Set<string> {
  const bundle = loadBundled();
  return new Set(bundle.packs.keys());
}

/** Resolves a case's checkout folder at its pinned base commit, or null when it is unavailable. */
export type CheckoutResolver = (c: LoadedCase) => string | null;

/** The eval workspace cache (eval/.work/<id>), used only when it sits clean at the pinned base commit. */
const baseCheckout: CheckoutResolver = (c) => checkoutAtBase(path.join(workDir(), c.case.id), c.case.base_commit);

/** Fails closed when a case with recorded runs has no checkout at its base: never score or render without it (D17). */
export function assertCommitsAvailable(ids: readonly string[]): void {
  if (ids.length) throw new Error(`case_commit_unavailable: ${ids.join(', ')} (run \`npm run cases:fetch\`)`);
}

/** The set of repo-relative files at a case's base checkout (for baseline citation resolution). */
function baseFiles(checkout: string): Set<string> {
  const out = execFileSync('git', ['-C', checkout, 'ls-files'], { encoding: 'utf8' });
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

export interface ScoredPack {
  pack: string;
  present: boolean;
  engine: Map<string, CaseRunRecall[]>;
  baseline: Map<string, CaseRunRecall[]>;
  hosts: Host[];
  trueUsages: number;
  goldenCases: number;
  commitUnavailable: string[];
}

/** Replay and score every recorded run of the cases of one pack. */
export async function scorePack(pack: string, cases: LoadedCase[], present: boolean, promptVersion: string, checkoutFor: CheckoutResolver = baseCheckout): Promise<ScoredPack> {
  const engine = new Map<string, CaseRunRecall[]>();
  const baseline = new Map<string, CaseRunRecall[]>();
  const hosts: Host[] = [];
  let trueUsages = 0;
  let goldenCases = 0;
  const commitUnavailable: string[] = [];

  for (const c of cases) {
    if (c.case.pack !== pack) continue;
    goldenCases += 1;
    const truth: Truth | null = c.truth;
    if (!truth) continue; // a case with no truth has no recorded runs yet
    trueUsages += truth.changed_usages.length;
    const checkout = checkoutFor(c);
    const engineRuns = loadEngineRuns(c.case.id, promptVersion);
    const baselineRuns = loadBaselineRuns(c.case.id);
    if ((engineRuns.length || baselineRuns.length) && !checkout) {
      commitUnavailable.push(c.case.id);
      continue;
    }
    const files = checkout ? baseFiles(checkout) : new Set<string>();
    const er: CaseRunRecall[] = [];
    for (const run of engineRuns) {
      const r = await replayEngineRun(run, truth, checkout!);
      hosts.push(r.host);
      er.push({ case_id: c.case.id, covered: r.score.recall.found, total: r.score.recall.total });
    }
    if (er.length) engine.set(c.case.id, er);
    const br: CaseRunRecall[] = [];
    for (const run of baselineRuns) {
      const r = replayBaselineRun(run, truth, files);
      hosts.push(r.host);
      br.push({ case_id: c.case.id, covered: r.score.recall.found, total: r.score.recall.total });
    }
    if (br.length) baseline.set(c.case.id, br);
  }
  return { pack, present, engine, baseline, hosts, trueUsages, goldenCases, commitUnavailable };
}

/** The base-branch band for a pack from a committed results.md on the base ref, or null. Parsed from CI, not here. */
export type BaseBands = Map<string, BaseBand>;

/** Build the results.md input from scored packs (pure once scoring is done). */
export function toResultsInput(packs: ScoredPack[], cases: LoadedCase[], packsHead: ReadonlySet<string>, promptVersion: string): Parameters<typeof renderResults>[0] {
  const packResults: PackResult[] = packs.map((p) => ({ pack: p.pack, present: p.present, engine: p.engine, baseline: p.baseline }));
  const pending = cases
    .filter((c) => !packsHead.has(c.case.pack))
    .map((c) => ({ id: c.case.id, pack: c.case.pack }));
  // Coverage gaps come from the committed matrix in eval/cases/README.md; M7 lists the empty cells there as a static note.
  const coverageGaps = readCoverageGaps();
  return {
    prompt_version: promptVersion,
    gates_hash: gatesHash(),
    packs: packResults,
    pending_cases: pending,
    removed: loadRemoved(),
    coverage_gaps: coverageGaps,
  };
}

/** The known coverage gaps, read from a committed JSON beside the matrix so results.md stays a pure function of HEAD. */
function readCoverageGaps(): string[] {
  const p = path.join(evalRoot(), 'cases', 'coverage-gaps.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as string[];
}

/** Generate results.md bytes for HEAD's tree. Throws `case_commit_unavailable` rather than rendering without a case. */
export async function generate(checkoutFor: CheckoutResolver = baseCheckout): Promise<string> {
  const promptVersion = currentPromptVersion();
  const cases = loadCases();
  const packsHead = packsAtHead();
  const packNames = [...new Set([...cases.map((c) => c.case.pack)].filter((p) => packsHead.has(p)))].sort();
  const packs: ScoredPack[] = [];
  for (const name of packNames) packs.push(await scorePack(name, cases, true, promptVersion, checkoutFor));
  assertCommitsAvailable(packs.flatMap((p) => p.commitUnavailable));
  return renderResults(toResultsInput(packs, cases, packsHead, promptVersion));
}

/** Run the pack gate for every pack at HEAD, with the base bands supplied by CI (empty = no base band). */
export async function runPackGate(baseBands: BaseBands, widenedPacks: ReadonlySet<string>): Promise<{ failures: string[]; notes: string[] }> {
  const promptVersion = currentPromptVersion();
  const cases = loadCases();
  const packsHead = packsAtHead();
  const packNames = [...new Set([...cases.map((c) => c.case.pack)].filter((p) => packsHead.has(p)))].sort();
  const failures: string[] = [];
  const notes: string[] = [];
  for (const name of packNames) {
    const scored = await scorePack(name, cases, true, promptVersion);
    const runs: PackRuns = {
      pack: name,
      engine: scored.engine,
      baseline: scored.baseline,
      hosts: scored.hosts,
      trueUsages: scored.trueUsages,
      goldenCases: scored.goldenCases,
      commit_unavailable: scored.commitUnavailable,
    };
    const verdict = packGate({
      runs,
      base: baseBands.get(name) ?? null,
      widening: widenedPacks.has(name),
      exemptFromBeat: name === 'nextjs-upgrade',
    });
    failures.push(...verdict.failures);
    notes.push(...verdict.notes);
  }
  return { failures, notes };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--pack-gate')) {
    // Base bands are parsed by CI from the base branch's results.md; until
    // golden runs exist, there is no base band and the beat check is exempt for
    // nextjs-upgrade, so the gate reports notes and passes.
    const { failures, notes } = await runPackGate(new Map(), new Set());
    for (const n of notes) process.stdout.write(`note: ${n}\n`);
    for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
    if (!failures.length) process.stdout.write('pack gate passed\n');
    return failures.length ? 1 : 0;
  }
  const smoke = argv.includes('--smoke');
  // Smoke (milestone gate): replay the seeded tier plus any golden runs, all
  // free (no model, no paid service, C1), and confirm results.md is in step.
  // Until golden runs are recorded, this reduces to the determinism check.
  const check = argv.includes('--check') || smoke;
  const md = await generate();
  if (!check) {
    writeFileSync(resultsPath(), md);
    process.stdout.write(`wrote ${path.relative(process.cwd(), resultsPath())}\n`);
    return 0;
  }
  const committed = existsSync(resultsPath()) ? readFileSync(resultsPath(), 'utf8') : null;
  if (committed !== md) {
    process.stderr.write('FAIL eval/results.md is stale: run `npm run eval -- --tier all` and commit it\n');
    return 1;
  }
  process.stdout.write('eval results check passed (results.md matches the re-score)\n');
  return 0;
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
