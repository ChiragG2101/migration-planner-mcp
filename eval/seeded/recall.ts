// Recall on the seeded-defect repos (M2 task 14). Runs scan_repo and
// find_usages on each repo under eval/seeded/ that has a ground_truth.json,
// compares the usages with the ground truth and prints recall per kind and
// overall, with every miss. Recall counts `change` and `no_change` entries
// (usages find_usages must find); `no_finding` decoys are scored at the plan
// level from M7, and any decoy that gets a usage is listed for information.
//
//   npx tsx eval/seeded/recall.ts                 writes eval/seeded/recall.md
//   npx tsx eval/seeded/recall.ts --check         fails if recall is below a repo's floor in
//                                                 ratchet.json, a repo has no floor, or recall.md is stale
//   npx tsx eval/seeded/recall.ts --check --base <git ref>
//                                                 also fails if a floor is lower than at <ref>, a floor
//                                                 was removed, or a new floor differs from the measured recall
//
// Pack-independent: M10 adds the Django seeded repo and its floor, nothing else.
// Outside the engine (it writes files and runs git), so src/ never imports it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeEngine, createEngine, findUsages, scanRepo } from '../../src/core/index.js';
import type { Usage } from '../../src/schema/usage.js';

const seededDir = path.dirname(fileURLToPath(import.meta.url));
const ratchetPath = path.join(seededDir, 'ratchet.json');
const recallMdPath = path.join(seededDir, 'recall.md');
const EPS = 1e-9;

export interface GroundTruthEntry {
  id: string;
  file: string;
  line: number;
  kind: string;
  expect: 'change' | 'no_change' | 'no_finding';
  indirect: boolean;
  note: string;
}

export interface GroundTruth {
  repo: string;
  library: string;
  source: string;
  target: string;
  entries: GroundTruthEntry[];
}

interface Tally {
  found: number;
  total: number;
}

export interface RecallResult {
  repo: string;
  adapter: string;
  library: string;
  source: string;
  target: string;
  overall: Tally;
  direct: Tally;
  indirect: Tally;
  byKind: Record<string, { direct: Tally; indirect: Tally }>;
  misses: GroundTruthEntry[];
  decoysWithUsage: GroundTruthEntry[];
}

export type Ratchet = Record<string, { overall: number }>;

export const ratio = (t: Tally): number => (t.total === 0 ? 1 : t.found / t.total);
const pct = (t: Tally): string => `${t.found}/${t.total} (${(ratio(t) * 100).toFixed(1)}%)`;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function seededRepos(): string[] {
  return readdirSync(seededDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(seededDir, d.name, 'ground_truth.json')))
    .map((d) => d.name)
    .sort(byName);
}

export function readRatchet(): Ratchet {
  return JSON.parse(readFileSync(ratchetPath, 'utf8')) as Ratchet;
}

const matches = (u: Usage, e: GroundTruthEntry): boolean => u.file === e.file && u.kind === e.kind && u.line_start <= e.line && e.line <= u.line_end;

/** Runs the engine on one seeded repo (output in a temp folder, never in the repo) and scores it. */
export async function measure(repo: string): Promise<RecallResult> {
  const root = path.join(seededDir, repo);
  const gt = JSON.parse(readFileSync(path.join(root, 'ground_truth.json'), 'utf8')) as GroundTruth;
  const out = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-recall-'));
  const engine = createEngine({ out });
  const usages: Usage[] = [];
  let adapter: string | undefined;
  try {
    const scan = await scanRepo(engine, { repo_path: root, source: { name: gt.library }, target: { name: gt.library, version: gt.target } });
    if (scan.status !== 'ok' || !scan.run) throw new Error(`scan_repo asked a question on ${repo}: ${JSON.stringify(scan.question)}`);
    let cursor: string | undefined;
    do {
      const page = await findUsages(engine, { run_id: scan.run.run_id, limit: 1000, ...(cursor ? { cursor } : {}) });
      usages.push(...page.usages);
      adapter = page.summary.adapter;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  } finally {
    closeEngine(engine);
    rmSync(out, { recursive: true, force: true });
  }

  const tally = (): Tally => ({ found: 0, total: 0 });
  const result: RecallResult = {
    repo,
    adapter: adapter ?? 'unknown',
    library: gt.library,
    source: gt.source,
    target: gt.target,
    overall: tally(),
    direct: tally(),
    indirect: tally(),
    byKind: {},
    misses: [],
    decoysWithUsage: [],
  };
  for (const e of gt.entries) {
    const hit = usages.some((u) => matches(u, e));
    if (e.expect === 'no_finding') {
      if (hit) result.decoysWithUsage.push(e);
      continue;
    }
    const k = (result.byKind[e.kind] ??= { direct: tally(), indirect: tally() });
    for (const t of [result.overall, e.indirect ? result.indirect : result.direct, e.indirect ? k.indirect : k.direct]) {
      t.total += 1;
      if (hit) t.found += 1;
    }
    if (!hit) result.misses.push(e);
  }
  return result;
}

export function renderRecallMd(results: readonly RecallResult[], ratchet: Ratchet): string {
  const lines = [
    '# Seeded-repo recall',
    '',
    'Generated by `npm run recall` (`eval/seeded/recall.ts`) from each seeded repo\'s `ground_truth.json`. Do not edit by hand.',
    '',
    'Recall counts the `change` and `no_change` entries: usages `find_usages` must find. A usage matches an entry when it has the same file and kind and its lines include the entry\'s line. `no_finding` decoys are scored at the plan level from M7; a decoy that gets a usage is listed for information. Each repo\'s floor is in `ratchet.json` and only moves up.',
  ];
  for (const r of results) {
    const floor = ratchet[r.repo]?.overall;
    lines.push(
      '',
      `## ${r.repo}`,
      '',
      `Adapter \`${r.adapter}\`, \`${r.library}\` ${r.source} to ${r.target}. Overall recall **${pct(r.overall)}**: direct ${pct(r.direct)}, indirect ${pct(r.indirect)}. Floor: ${floor === undefined ? 'none' : floor.toFixed(4)}.`,
      '',
      '| Kind | Direct | Indirect |',
      '| --- | --- | --- |',
    );
    for (const kind of Object.keys(r.byKind).sort(byName)) {
      const k = r.byKind[kind]!;
      const cell = (t: Tally): string => (t.total ? `${t.found}/${t.total}` : '-');
      lines.push(`| \`${kind}\` | ${cell(k.direct)} | ${cell(k.indirect)} |`);
    }
    lines.push('', r.misses.length ? 'Misses:' : 'Misses: none.');
    for (const m of r.misses) lines.push(`- \`${m.id}\` ${m.file}:${m.line} \`${m.kind}\`${m.indirect ? ' (indirect)' : ''}: ${m.note}`);
    lines.push('', r.decoysWithUsage.length ? 'Decoys with a usage:' : 'Decoys with a usage: none.');
    for (const d of r.decoysWithUsage) lines.push(`- \`${d.id}\` ${d.file}:${d.line} \`${d.kind}\`: ${d.note}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The ratchet at a git ref: `{}` when the file doesn't exist there; an error when the ref doesn't. */
function ratchetAt(ref: string): Ratchet {
  const rel = path.relative(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), ratchetPath).split(path.sep).join('/');
  execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${rel}`], { stdio: 'ignore' });
  } catch {
    return {};
  }
  return JSON.parse(execFileSync('git', ['show', `${ref}:${rel}`], { encoding: 'utf8' })) as Ratchet;
}

/** The problems `--check` reports; empty when everything holds. */
export function checkProblems(results: readonly RecallResult[], ratchet: Ratchet, recallMd: string | null, base: Ratchet | null): string[] {
  const problems: string[] = [];
  for (const r of results) {
    const floor = ratchet[r.repo]?.overall;
    const measured = ratio(r.overall);
    if (floor === undefined) problems.push(`${r.repo}: no floor in ratchet.json (a new entry starts at the measured ${measured.toFixed(4)})`);
    else if (measured + EPS < floor) problems.push(`${r.repo}: recall ${measured.toFixed(4)} is below its floor ${floor.toFixed(4)}`);
  }
  if (recallMd !== renderRecallMd(results, ratchet)) problems.push('eval/seeded/recall.md is stale: run `npm run recall` and commit it');
  if (base) {
    for (const [repo, { overall }] of Object.entries(base)) {
      const now = ratchet[repo]?.overall;
      if (now === undefined) problems.push(`${repo}: its floor was removed from ratchet.json`);
      else if (now + EPS < overall) problems.push(`${repo}: floor lowered from ${overall.toFixed(4)} to ${now.toFixed(4)}; the ratchet only moves up`);
    }
    for (const r of results) {
      const now = ratchet[r.repo]?.overall;
      if (now !== undefined && !(r.repo in base) && Math.abs(now - ratio(r.overall)) > EPS) {
        problems.push(`${r.repo}: a new floor must equal the measured recall ${ratio(r.overall).toFixed(4)}, not ${now.toFixed(4)}`);
      }
    }
  }
  return problems;
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');
  const baseIdx = argv.indexOf('--base');
  const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  if (baseIdx >= 0 && !baseRef) throw new Error('--base needs a git ref');
  const results: RecallResult[] = [];
  for (const repo of seededRepos()) results.push(await measure(repo));
  const ratchet = readRatchet();
  for (const r of results) {
    process.stdout.write(`${r.repo}: recall ${pct(r.overall)} (direct ${pct(r.direct)}, indirect ${pct(r.indirect)}), ${r.misses.length} misses\n`);
    for (const m of r.misses) process.stdout.write(`  miss ${m.id} ${m.file}:${m.line} ${m.kind}\n`);
  }
  if (!check) {
    writeFileSync(recallMdPath, renderRecallMd(results, ratchet));
    process.stdout.write(`wrote ${path.relative(process.cwd(), recallMdPath)}\n`);
    return 0;
  }
  const recallMd = existsSync(recallMdPath) ? readFileSync(recallMdPath, 'utf8') : null;
  const problems = checkProblems(results, ratchet, recallMd, baseRef ? ratchetAt(baseRef) : null);
  for (const p of problems) process.stderr.write(`FAIL ${p}\n`);
  if (!problems.length) process.stdout.write(`recall check passed${baseRef ? ` (ratchet compared with ${baseRef})` : ''}\n`);
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
