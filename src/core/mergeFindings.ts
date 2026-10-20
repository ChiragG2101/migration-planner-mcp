// merge_findings (M6 task 1). The deterministic aggregator runs here: it reads
// the run's stored findings, lens marks, scope exclusions, usages and import
// graph, builds the plan (or the engine-built `none` plan), stores it at round
// 1, and records a conflict event for every merge decision. Calling it freezes
// the run's scope (merge.started), which set_scope already refuses on (D12).
import { z } from 'zod';
import { snippetHash, sliceLines } from '../analysis/snippet.js';
import { hiddenBehavior } from '../analysis/sizing.js';
import { aggregate, aggregateNone, type AggregateInput, type AggregateResult } from '../pipeline/aggregate.js';
import { ScanResult } from '../schema/scan.js';
import type { Size } from '../schema/scope.js';
import type { Finding } from '../schema/finding.js';
import { MergeFindingsInput, type MergeFindingsOutput } from '../schema/plan.js';
import { InputError } from '../security/errors.js';
import { resolveInside } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';
import { repoRoot } from '../store/campaigns.js';
import { listEvents } from '../store/events.js';
import { listFindings, listMarks } from '../store/findings.js';
import { putPlan } from '../store/plans.js';
import { getScope } from '../store/scope.js';
import { loadPrompt } from '../security/promptFile.js';
import { runTool, type Engine } from './engine.js';
import { composeRun, openRunPack, requireUsages, type RunPack } from './packRun.js';

const MERGE_ROUND = 1;

/** The templated version-bump finding the engine builds (source: rule_pack). Evidence is the dependency's manifest line. */
function bumpFinding(opened: RunPack, scan: ScanResult, root: string, promptVersion: string): Finding {
  const name = opened.versions.source.name;
  const pkg = scan.packages.find((p) => p.dependencies.some((d) => d.name === name));
  const dep = pkg?.dependencies.find((d) => d.name === name);
  const manifest = dep?.declared_in ?? pkg?.manifests[0] ?? 'package.json';
  const from = opened.versions.source.version;
  const to = opened.versions.target.version;
  // Find the manifest line that declares the dependency, so gate 1 resolves.
  let line = 1;
  let snippet: string;
  try {
    const text = readText(resolveInside(root, manifest, opened.run.repo_id));
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const idx = lines.findIndex((l) => new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(l));
    line = idx >= 0 ? idx + 1 : 1;
    snippet = snippetHash(sliceLines(text, line, line));
  } catch {
    // The manifest could not be read; gate 1 will flag the evidence, which is honest.
    snippet = snippetHash('');
  }
  return {
    id: 'engine-bump',
    repo_id: opened.run.repo_id,
    lens: 'combined',
    concern: 'dependency',
    severity: 'high',
    evidence: [{ repo_id: opened.run.repo_id, file: manifest, line_start: line, line_end: line, snippet_hash: snippet }],
    doc_refs: [],
    reasoning: `Bump ${name} from ${from} to ${to} and resolve any peer-dependency conflicts.`,
    action: `In ${manifest}, change ${name} to ${to}, then update the lockfile.`,
    step_kind: 'manual',
    rollback: `Revert ${manifest} and the lockfile to pin ${name} ${from} again.`,
    verify: opened.pack.pack.checks_hint,
    confidence: 1,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: promptVersion,
  };
}

export async function mergeFindings(engine: Engine, raw: unknown): Promise<MergeFindingsOutput> {
  const parsed = MergeFindingsInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'merge_findings', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const events = listEvents(db, opened.run.id);
    const set = events.findLast((e) => e.kind === 'scope.set');
    if (!set) throw new InputError('no_scope', 'call set_scope before merge_findings');
    const size = (JSON.parse(set.payload_json) as { size: Size }).size;
    const scanEvent = events.findLast((e) => e.kind === 'scan.result');
    if (!scanEvent) throw new InputError('no_scan', `run ${opened.run.id} has no scan; call scan_repo first`);
    const scan = ScanResult.parse(JSON.parse(scanEvent.payload_json));
    const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
    if (!root) throw new InputError('unknown_run', `run ${opened.run.id} has no repo`);

    // Freeze scope before reading anything, so a late set_scope is already refused.
    if (!events.some((e) => e.kind === 'merge.started')) call.event('merge.started', { size });

    const loaded = requireUsages(opened.session, opened.run.id);
    const scope = getScope(db, opened.run.id);
    const stop = scope?.answers['stop_at'];
    const composed = composeRun(opened.pack, opened.versions, {
      ...(typeof stop === 'string' ? { stopAt: stop } : {}),
      usages: loaded.usages,
    });
    const prompt = loadPrompt();
    const input: AggregateInput = {
      runId: opened.run.id,
      campaignId: opened.run.campaign_id,
      repoId: opened.run.repo_id,
      packRef: opened.run.versions_json ? packRef(opened) : opened.pack.pack.name,
      promptVersion: prompt.version,
      size,
      findings: listFindings(db, opened.run.id).map((f) => f.finding),
      marks: listMarks(db, opened.run.id).map((m) => ({ lens: m.lens, usage_id: m.usage_id, reason: m.reason })),
      scopeExcluded: (scope?.out_of_scope ?? []).map((o) => ({ usage_id: o.usage_id, reason: o.reason })),
      usages: loaded.usages,
      imports: loaded.imports,
      composed,
      staging: opened.pack.pack.staging,
      kind: opened.pack.pack.kind,
      bumpFinding: bumpFinding(opened, scan, root, prompt.version),
      hiddenBehavior: hiddenBehavior(composed.libraries.flatMap((l) => l.rules)),
    };
    const result: AggregateResult = size === 'none' ? aggregateNone(input) : aggregate(input);
    for (const c of result.conflicts) call.event('conflict', c);
    if (result.droppedFindings.length) call.event('findings.dropped', { ids: result.droppedFindings });
    putPlan(db, opened.run.id, result.plan, MERGE_ROUND, 'draft');
    call.event('merge.result', { size, stages: result.plan.stages.length, findings: result.plan.findings.length, uncovered: result.uncovered.length, conflicts: result.conflicts.length });
    return {
      run_id: opened.run.id,
      round: MERGE_ROUND,
      size,
      plan: result.plan,
      uncovered_usages: result.uncovered,
      conflicts: result.conflicts,
      dropped_findings: result.droppedFindings,
    };
  });
}

function packRef(opened: RunPack): string {
  const v = JSON.parse(opened.run.versions_json) as { pack?: string | null };
  return v.pack ?? opened.pack.pack.name;
}