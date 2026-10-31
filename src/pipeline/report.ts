// run_report.md (M9 task 4). Built only from the run's event rows, so every
// number in it traces to an event and nothing is held only in memory. emit_plan
// records the facts it computes (routing, coverage, versions, the after-hash
// and, when L1 ran, the verify report) as events first, then builds this from
// the full event list. A short summary block comes first; the detail follows.
// Deterministic text only; no file writes happen here.
import { createHash } from 'node:crypto';

/** The fields of an event row the report reads (the `events` table, PRD section 7). */
export interface ReportEvent {
  ts: string;
  step: string;
  kind: string;
  payload_json: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** The engine's hash of the files it reads: path and content hash of each walked file, sorted. Deny-listed and over-limit files are not read, so not hashed. */
export function treeHash(files: readonly { path: string; sha256: string }[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

// --- payload shapes the report reads (each optional: an older run may lack an event) ---

interface IngestRun {
  run?: { run_id: string; campaign_id: string; repo_id: string };
  versions?: { source: { name: string; version: string }; target: { name: string; version: string } };
  pack?: string | null;
  companions?: Record<string, string>;
}
interface ScopeProposed {
  size: string;
  reasons?: string[];
  questions: string[];
  defaults?: Record<string, string | string[]>;
  small_max_usages?: number;
}
interface ScopeSet {
  size: string;
  answers: Record<string, string | string[]>;
  defaults: string[];
  excluded?: { usage_id: string; reason: string }[];
}
interface UsagesSummary {
  total?: number;
  unparsed_files?: { file: string; message: string; partial: boolean }[];
  unresolved_dynamic?: { file: string; line: number; kind: string }[];
  skipped_by_limit?: { path: string; reason: string }[];
  skipped_generated?: string[];
  peer_data_unavailable?: string[];
}
interface ScanPayload {
  root?: string;
  files?: { read: number; bytes: number };
  skipped?: { path: string; reason: string }[];
}
interface DocEvent {
  doc_id: string;
  url: string;
  fetched_by: string;
  official: boolean;
  status: string;
}
interface GateRound {
  round: number;
  status: string;
  results: { gate: string; subject: string | null; pass: boolean; reason: string }[];
}
interface ReviewItem {
  reason: string;
  finding_id: string | null;
  stage_id: string | null;
  usage_id: string | null;
  detail: string;
}
export interface RoutingFacts {
  threshold: number;
  threshold_source: 'default' | 'flag';
  review_first: ReviewItem[];
  needs_human: string[];
  main: number;
}
export interface ReportFacts {
  versions: { engine: string; pack: string; pack_version: string; prompt: string; codemod_registry: string; gates: string[] };
  plan: { status: string; round: number; stages: number; findings: number; unresolved: number; l1_unresolved_stages: number };
  coverage: { found: number; covered: number; out_of_scope: Record<string, Record<string, number>>; uncovered: number };
  budget: { limits: { tokens?: number; seconds?: number }; used: { tokens: number; seconds: number } };
}
interface ExecRun {
  kind: string;
  argv: string[];
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
}
interface CheckResult {
  name: string;
  status: string;
  exit_code: number | null;
  duration_ms: number;
}
interface VerifyReportPayload {
  sandbox_path: string | null;
  source_head: string | null;
  baseline_checks: CheckResult[];
  stages: {
    stage_id: string;
    title: string;
    decision: string | null;
    attempts: {
      attempt: number;
      codemods: { id: string; status: string; duration_ms: number }[];
      checks: CheckResult[];
      gate7: { pass: boolean; violations: { rule: string; file: string; detail: string }[] };
      decision: string;
    }[];
    patch_path: string | null;
  }[];
  apply_command: string | null;
}

const parse = <T>(e: ReportEvent): T => JSON.parse(e.payload_json) as T;
const all = <T>(events: readonly ReportEvent[], kind: string): T[] => events.filter((e) => e.kind === kind).map((e) => parse<T>(e));
const last = <T>(events: readonly ReportEvent[], kind: string): T | undefined => {
  const e = events.findLast((x) => x.kind === kind);
  return e && parse<T>(e);
};
const NR = '_not recorded_';
const count = (xs: readonly string[]): [string, number][] => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const LIST_CAP = 20;
function capped(lines: readonly string[], more: string): string[] {
  return lines.length > LIST_CAP ? [...lines.slice(0, LIST_CAP), `- …and ${lines.length - LIST_CAP} more (${more})`] : [...lines];
}

/** Steps an L1 run may use the network for. Clone mode does not isolate the network, so these are reported, not blocked (C6 covers only the engine's own traffic). */
const NETWORK_NOTE: Record<string, string> = {
  install: 'your install command (package downloads)',
  codemod: 'a pinned codemod run through its runner (the runner may download the pinned package)',
  check: 'your check command (the engine cannot tell whether it uses the network)',
};

export function buildRunReport(runId: string, events: readonly ReportEvent[]): string {
  const ingest = last<IngestRun>(events, 'ingest.run');
  const scan = last<ScanPayload>(events, 'scan.result');
  const usages = last<UsagesSummary>(events, 'usages.result');
  const proposed = last<ScopeProposed>(events, 'scope.proposed');
  const scope = last<ScopeSet>(events, 'scope.set');
  const routing = last<RoutingFacts>(events, 'routing.result');
  const facts = last<ReportFacts>(events, 'report.facts');
  const rounds = all<GateRound>(events, 'gate.result');
  const verify = last<VerifyReportPayload>(events, 'verify.report');
  const execs = all<ExecRun>(events, 'exec.run');
  const cuts = all<{ what: string; id: string; reason: string }>(events, 'budget.cut');
  const hashes = all<{ phase: string; hash: string; files: number }>(events, 'repo.hash');
  const before = hashes.find((h) => h.phase === 'scan');
  const after = hashes.findLast((h) => h.phase === 'emit');
  const untouched = before && after ? before.hash === after.hash : null;
  const scanInput = events.find((e) => e.kind === 'tool.start' && (e.step === 'scan_repo' || e.step === 'ingest'));

  const out: string[] = [`# Run report`, '', `Run \`${runId}\`. Every number below is read from this run's events in the store.`, ''];

  // --- summary ---
  out.push('## Summary', '');
  out.push(`- Size: **${scope?.size ?? proposed?.size ?? 'not recorded'}**`);
  if (facts) {
    out.push(`- Plan: ${facts.plan.status} after round ${facts.plan.round}; ${plural(facts.plan.stages, 'stage')}, ${plural(facts.plan.findings, 'finding')}, ${facts.plan.unresolved + facts.plan.l1_unresolved_stages} unresolved`);
    out.push(`- Coverage: ${facts.coverage.covered} of ${facts.coverage.found} usages covered by findings, ${facts.coverage.uncovered} uncovered`);
  }
  if (routing) out.push(`- Review first: ${routing.review_first.length}; needs human decision: ${routing.needs_human.length} (confidence threshold ${routing.threshold}, ${routing.threshold_source})`);
  if (verify) {
    const kept = verify.stages.filter((s) => s.decision === 'kept').length;
    out.push(`- Verify (L1): ${kept} of ${verify.stages.length} stages kept`);
  }
  out.push(`- Budget cuts: ${cuts.length}`);
  out.push(`- Target repo untouched: ${untouched === null ? 'not checked' : untouched ? 'yes (hash unchanged)' : '**hash changed** (see the last section)'}`);
  out.push('');

  // --- inputs ---
  out.push('## Inputs', '');
  if (ingest?.run) out.push(`- Campaign \`${ingest.run.campaign_id}\`, repo \`${ingest.run.repo_id}\``);
  else out.push(`- Campaign and repo IDs: ${NR}`);
  if (scan?.root) out.push(`- Repo: \`${scan.root}\``);
  if (scanInput) out.push(`- Request: \`${JSON.stringify((parse<{ input: unknown }>(scanInput)).input)}\``);
  if (ingest?.versions) out.push(`- Resolved: ${ingest.versions.source.name} ${ingest.versions.source.version} → ${ingest.versions.target.name} ${ingest.versions.target.version}`);
  const companions = Object.entries(ingest?.companions ?? {});
  if (companions.length) out.push(`- Companions installed: ${companions.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push('');

  out.push('## Versions', '');
  if (facts) {
    const v = facts.versions;
    out.push(`- Engine ${v.engine}; pack \`${v.pack}\` (version ${v.pack_version}); prompt ${v.prompt}`);
    out.push(`- Gates: ${v.gates.join(', ')}; codemod registry ${v.codemod_registry}`);
  } else out.push(`- ${NR}`);
  out.push('');

  // --- size and scope ---
  out.push('## Size and scope', '');
  if (proposed) {
    out.push(`- Computed size: **${proposed.size}**`);
    for (const r of proposed.reasons ?? []) out.push(`  - ${r}`);
  } else out.push(`- Computed size: ${NR}`);
  if (scope) {
    if (scope.size !== proposed?.size) out.push(`- Size after the scope answers: **${scope.size}**`);
    const ids = proposed?.questions ?? Object.keys(scope.answers);
    if (!ids.length) out.push('- No scope questions were offered.');
    for (const id of ids) {
      const a = scope.answers[id];
      out.push(`- ${id}: \`${Array.isArray(a) ? a.join(', ') : String(a)}\`${scope.defaults.includes(id) ? ' (default)' : ''}`);
    }
    const excluded = scope.excluded ?? [];
    for (const [reason, n] of count(excluded.map((x) => x.reason))) {
      out.push(`- ${reason} excluded ${n} usage${n === 1 ? '' : 's'}:`);
      out.push(...capped(excluded.filter((x) => x.reason === reason).map((x) => `  - \`${x.usage_id}\``), 'plan.json out_of_scope'));
    }
    if (!excluded.length) out.push('- The answers excluded no usage.');
  } else out.push(`- Scope answers: ${NR}`);
  out.push('');

  // --- coverage ---
  out.push('## Coverage', '');
  if (facts) {
    const c = facts.coverage;
    out.push(`- Usages found: ${c.found}`, `- Covered by a finding: ${c.covered}`);
    const writers = Object.keys(c.out_of_scope).sort();
    const total = writers.reduce((n, w) => n + Object.values(c.out_of_scope[w]!).reduce((a, b) => a + b, 0), 0);
    out.push(`- Out of scope: ${total}`);
    for (const w of writers) {
      for (const [reason, n] of Object.entries(c.out_of_scope[w]!).sort()) out.push(`  - by ${w}: ${n} — ${reason}`);
    }
    out.push(`- Uncovered: ${c.uncovered}`);
  } else out.push(`- ${NR}`);
  out.push('');

  // --- unparsed and skipped ---
  out.push('## Unparsed and skipped files', '');
  if (scan?.files) out.push(`- Files read: ${scan.files.read} (${scan.files.bytes} bytes)`);
  const skipped = scan?.skipped ?? [];
  for (const [reason, n] of count(skipped.map((s) => s.reason))) out.push(`- Skipped at scan (${reason}): ${n}`);
  if (usages) {
    const unparsed = usages.unparsed_files ?? [];
    out.push(`- Unparsed: ${unparsed.length}`);
    out.push(...capped(unparsed.map((u) => `  - \`${u.file}\`${u.partial ? ' (partial)' : ''}: ${u.message}`), 'find_usages summary'));
    out.push(`- Unresolved dynamic imports: ${(usages.unresolved_dynamic ?? []).length}`);
    out.push(...capped((usages.unresolved_dynamic ?? []).map((u) => `  - \`${u.file}:${u.line}\` (${u.kind})`), 'find_usages summary'));
    out.push(`- Skipped by size limit: ${(usages.skipped_by_limit ?? []).length}`);
    out.push(`- Build output not analysed: ${(usages.skipped_generated ?? []).join(', ') || 'none'}`);
    if ((usages.peer_data_unavailable ?? []).length) out.push(`- Lockfiles with no peer data: ${usages.peer_data_unavailable!.join(', ')}`);
  } else out.push(`- Usage summary: ${NR}`);
  out.push('');

  // --- docs ---
  out.push('## Docs', '');
  const docs = new Map<string, DocEvent>();
  for (const d of all<DocEvent>(events, 'docs.retrieved')) docs.set(d.doc_id, d);
  const docList = [...docs.values()];
  const fallbacks = events.filter((e) => e.kind === 'docs.fallback').length;
  out.push(`- Docs used: ${docList.length} (fresh ${docList.filter((d) => d.status === 'fresh').length}, stale ${docList.filter((d) => d.status === 'stale').length}, unverified ${docList.filter((d) => d.status === 'unverified').length})`);
  for (const by of ['engine', 'agent', 'knowledge']) {
    const of = docList.filter((d) => d.fetched_by === by);
    if (of.length) out.push(`  - fetched by ${by}: ${of.length} (official ${of.filter((d) => d.official).length}, not official ${of.filter((d) => !d.official).length})`);
  }
  out.push(`- Fallback events (Context7 unavailable, cache or knowledge used): ${fallbacks}`);
  out.push('- Docs the agent registered are checked for where they come from, not for what they say.');
  out.push('');

  // --- gates ---
  out.push('## Gate results', '');
  if (!rounds.length) out.push(`- ${NR}`);
  for (const r of rounds) {
    const failed = r.results.filter((x) => !x.pass);
    out.push(`- Round ${r.round}: ${r.status}, ${r.results.length - failed.length} pass, ${failed.length} fail`);
    out.push(...capped(failed.map((f) => `  - ${f.gate}${f.subject ? ` [${f.subject}]` : ''}: ${f.reason}`), 'the gate.result event'));
  }
  out.push('');

  // --- verify (only when L1 ran) ---
  if (verify) {
    out.push('## Verify (L1)', '');
    out.push(`- Sandbox: \`${verify.sandbox_path ?? 'none'}\` at source HEAD \`${verify.source_head ?? 'unknown'}\``);
    out.push('- Baseline checks:');
    if (!verify.baseline_checks.length) out.push('  - none declared');
    for (const c of verify.baseline_checks) out.push(`  - ${c.name}: ${c.status} (exit ${c.exit_code ?? '?'})`);
    const flaky = new Set<string>();
    for (const s of verify.stages) {
      out.push(`- Stage \`${s.stage_id}\` (${s.title}): ${s.decision ?? 'not attempted'}, ${s.attempts.length} attempt${s.attempts.length === 1 ? '' : 's'}${s.patch_path ? `, patch \`${s.patch_path}\`` : ''}`);
      for (const a of s.attempts) {
        const checks = a.checks.map((c) => `${c.name} ${c.status} exit ${c.exit_code ?? '?'} in ${c.duration_ms} ms`).join('; ') || 'no checks';
        out.push(`  - attempt ${a.attempt}: ${a.decision}; checks: ${checks}; gate 7 ${a.gate7.pass ? 'pass' : `fail (${a.gate7.violations.map((v) => `${v.rule} ${v.file}`).join('; ')})`}${a.codemods.length ? `; codemods: ${a.codemods.map((m) => `${m.id} ${m.status}`).join(', ')}` : ''}`);
        for (const c of a.checks) if (c.status === 'flaky') flaky.add(c.name);
      }
    }
    out.push(`- Flaky checks: ${[...flaky].sort().join(', ') || 'none'}`);
    out.push(`- Commands run: ${execs.length}`);
    for (const x of execs) out.push(`  - [${x.kind}] \`${x.argv.join(' ')}\` → exit ${x.exit_code}${x.timed_out ? ' (timed out)' : ''} in ${x.duration_ms} ms`);
    const net = execs.filter((x) => x.kind in NETWORK_NOTE);
    out.push(`- Steps that may use the network: ${net.length}`);
    for (const [kind, n] of count(net.map((x) => x.kind))) out.push(`  - ${n} × ${NETWORK_NOTE[kind]}`);
    out.push(`- Apply the kept patches yourself: ${verify.apply_command ? `\`${verify.apply_command}\`` : 'no patch was kept'}`);
    out.push('');
  }

  // --- dropped ---
  out.push('## Dropped and why', '');
  // Merge decisions come from the last merge_findings call, the one that built the stored plan.
  const mergeEnd = events.findLastIndex((e) => e.kind === 'merge.result');
  const mergeStart = mergeEnd < 0 ? -1 : events.slice(0, mergeEnd).findLastIndex((e) => e.kind === 'tool.start' && e.step === 'merge_findings');
  const lastMerge = mergeEnd < 0 ? [] : events.slice(Math.max(mergeStart, 0), mergeEnd + 1);
  const conflicts = all<{ kind: string; detail: string }>(lastMerge, 'conflict');
  out.push(`- Merge conflicts and dedupe decisions: ${conflicts.length}`);
  out.push(...capped(conflicts.map((c) => `  - ${c.kind}: ${c.detail}`), 'conflict events'));
  const dropped = all<{ ids: string[] }>(lastMerge, 'findings.dropped').flatMap((d) => d.ids);
  out.push(`- Findings kept out of the plan (scope left them covering no usage): ${dropped.length}${dropped.length ? ` — ${[...new Set(dropped)].join(', ')}` : ''}`);
  const gaps = all<{ lens: string }>(events, 'lens.gap');
  out.push(`- Lens gaps (two invalid submissions): ${gaps.length}${gaps.length ? ` — ${gaps.map((g) => g.lens).join(', ')}` : ''}`);
  out.push(`- Invalid lens submissions: ${events.filter((e) => e.kind === 'lens.invalid').length}`);
  out.push(`- Budget cuts: ${cuts.length}`);
  for (const c of cuts) out.push(`  - ${c.what} \`${c.id}\`: ${c.reason}`);
  out.push('');

  // --- cost and time ---
  out.push('## Cost and time', '');
  const steps = new Map<string, { calls: number; ms: number; tokens: number }>();
  for (const e of events) {
    const s = steps.get(e.step) ?? { calls: 0, ms: 0, tokens: 0 };
    if (e.kind === 'tool.end' || e.kind === 'tool.error') s.calls += 1;
    if (e.kind === 'tool.end') s.ms += parse<{ duration_ms: number }>(e).duration_ms;
    s.tokens += (e.tokens_in ?? 0) + (e.tokens_out ?? 0);
    steps.set(e.step, s);
  }
  out.push('| Step | Calls | Time (ms) | Tokens reported |', '| --- | --- | --- | --- |');
  for (const [step, s] of [...steps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (s.calls || s.tokens) out.push(`| ${step} | ${s.calls} | ${s.ms} | ${s.tokens} |`);
  }
  out.push('');
  out.push('- Calls count finished and failed tool calls; the emit that writes this report has not finished yet, so it is not counted.');
  if (facts) {
    const b = facts.budget;
    out.push(`- Budget: tokens ${b.limits.tokens ?? 'none'}, seconds ${b.limits.seconds ?? 'none'}; used ${b.used.tokens} tokens over ${Math.round(b.used.seconds)} s of run time`);
  }
  out.push('- Tokens are counted only when the host reports them.');
  out.push('');

  // --- repo untouched ---
  out.push('## Target repo untouched', '');
  if (before && after) {
    out.push(`- Before (scan): \`${before.hash}\` over ${before.files} files`);
    out.push(`- After (emit): \`${after.hash}\` over ${after.files} files`);
    out.push(untouched ? '- The hashes match: the engine did not modify the target repo.' : '- The hashes differ. The engine writes only under the output folder, so the repo changed outside it between the scan and the emit; re-run the plan on the current tree.');
  } else out.push(`- ${NR}`);
  out.push('- The hash covers the files the engine reads; deny-listed and over-limit files are not read, so they are not hashed.');
  return out.join('\n') + '\n';
}
