// propose_scope and set_scope. Scope only narrows, and it freezes at the first
// lens packet or the first merge (D12).
import { z } from 'zod';
import { computeSize, DEFAULT_SMALL_MAX, hiddenBehavior, type SizeInput } from '../analysis/sizing.js';
import { isEntrypoint, isTestFile, riskOf } from '../analysis/risk.js';
import { checkStopAt, type ComposedRule, type PackComposition } from '../rules/compose.js';
import { bindsTo } from '../rules/match.js';
import { releaseUnitOf, parseVersion, compareReleaseUnits } from '../rules/versions.js';
import type { RunVersions } from '../schema/ingest.js';
import { ProposeScopeInput, SetScopeInput, type ProposeScopeOutput, type ScopeAnswers, type ScopeQuestion, type SetScopeOutput, type Size } from '../schema/scope.js';
import type { Usage } from '../schema/usage.js';
import { InputError } from '../security/errors.js';
import { currentLevel } from '../security/level.js';
import { listEvents } from '../store/events.js';
import { getScope, putScope, type OutOfScope } from '../store/scope.js';
import { runTool, type Engine } from './engine.js';
import { composeRun, openRunPack, requireUsages, type RunPack } from './packRun.js';

const SIZE_RANK: Record<Size, number> = { none: 0, small: 1, full: 2 };

interface Facts {
  usages: Usage[];
  risks: ReturnType<typeof riskOf>[];
  size: ReturnType<typeof computeSize>;
  composed: PackComposition;
  packages: string[];
  questions: ScopeQuestion[];
}

function releaseUnits(pack: RunPack, versions: RunVersions): string[] {
  const lib = pack.pack.primary.library;
  const scheme = lib.version_scheme;
  const unit = lib.release_unit;
  const start = releaseUnitOf(parseVersion(scheme, versions.source.version), unit);
  const end = releaseUnitOf(parseVersion(scheme, versions.target.version), unit);
  if (unit !== 'major') return compareReleaseUnits(end, start, unit) > 0 ? [end.text] : [];
  const from = start.release[0]! + 1;
  const to = end.release[0]!;
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(String(n));
  return out.filter((u) => {
    try {
      checkStopAt(pack.pack.pack, lib, u);
      return true;
    } catch {
      return false;
    }
  });
}

function factsOf(opened: RunPack, smallMax: number): Facts {
  const loaded = requireUsages(opened.session, opened.run.id);
  const scan = listEvents(opened.session.db, opened.run.id).findLast((e) => e.kind === 'scan.result');
  if (!scan) throw new InputError('no_scan', `run ${opened.run.id} has no scan; call scan_repo first`);
  const packages = (JSON.parse(scan.payload_json) as { packages?: { path: string; dependencies: { name: string }[] }[] }).packages ?? [];
  const name = opened.versions.source.name;
  const users = packages.filter((p) => p.dependencies.some((d) => d.name === name)).map((p) => p.path);
  const composed = composeRun(opened.pack, opened.versions, { usages: loaded.usages });
  const rules = composed.libraries.flatMap((l) => l.rules);
  const importers = new Map<string, Set<string>>();
  const testers = new Set<string>();
  for (const edge of loaded.imports) {
    if (!edge.to_file) continue;
    const set = importers.get(edge.to_file) ?? new Set<string>();
    set.add(edge.from_file);
    importers.set(edge.to_file, set);
    if (isTestFile(edge.from_file)) testers.add(edge.to_file);
  }
  const risks = loaded.usages.map((u) => riskOf(u, rules, { fanIn: importers.get(u.file)?.size ?? 0, tested: testers.has(u.file), entrypoint: isEntrypoint(u.file) }));
  const matched = risks.filter((r) => !r.unmapped);
  const input: SizeInput = {
    risks,
    matched: matched.length,
    codemodCovered: matched.filter((r) => rules.find((c) => c.rule.id === r.rule_id)?.rule.codemod).length,
    unparsed: loaded.unparsed,
    unresolved: loaded.unresolved,
    skippedByLimit: loaded.skipped,
    peerConflicts: loaded.usages.filter((u) => u.labels.includes('peer_conflict')).length,
    olderThanCovered: composed.notes.some((n) => n.kind === 'not_checked_before'),
    olderThanSupported: composed.notes.some((n) => n.kind === 'older_than_supported'),
    smallMax,
  };
  const questions: ScopeQuestion[] = [];
  if (users.length > 1) {
    questions.push({
      id: 'targets',
      prompt: 'Which packages should the plan cover?',
      options: users.map((p) => ({ id: p, label: p === '.' ? 'the repo root' : p })),
      default: users,
    });
  }
  const stops = releaseUnits(opened, opened.versions);
  if (stops.length > 1) {
    questions.push({
      id: 'stop_at',
      prompt: 'Stop the upgrade at which release?',
      options: stops.map((s) => ({ id: s, label: s })),
      default: stops.at(-1)!,
    });
  }
  if (matched.some((r) => r.necessity === 'deprecated')) {
    questions.push({
      id: 'include_deprecated',
      prompt: 'Include usages that are deprecated but still work?',
      options: [
        { id: 'yes', label: 'yes' },
        { id: 'no', label: 'no' },
      ],
      default: 'yes',
    });
  }
  const size = computeSize(input);
  if (size.size !== 'full') {
    questions.push({
      id: 'depth',
      prompt: 'Plan at the computed size, or in full?',
      options: [
        { id: size.size, label: size.size },
        { id: 'full', label: 'full' },
      ],
      default: size.size,
    });
  }
  return { usages: loaded.usages, risks, size, composed, packages: users, questions };
}

export async function proposeScope(engine: Engine, raw: unknown): Promise<ProposeScopeOutput> {
  const parsed = ProposeScopeInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  const smallMax = parsed.data.small_max_usages ?? DEFAULT_SMALL_MAX;
  return runTool(engine, opened.session, 'propose_scope', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const facts = factsOf(opened, smallMax);
    const out: ProposeScopeOutput = {
      run_id: opened.run.id,
      size: facts.size.size,
      reasons: facts.size.reasons,
      questions: facts.questions,
      hidden_behavior: facts.size.size === 'none' ? hiddenBehavior(facts.composed.libraries.flatMap((l) => l.rules)) : [],
      info: { level: currentLevel(), checks_declared: false },
      small_max_usages: smallMax,
    };
    const existing = getScope(opened.session.db, opened.run.id);
    putScope(opened.session.db, opened.run.id, {
      answers: existing?.answers ?? {},
      defaults: existing?.defaults ?? [],
      out_of_scope: existing?.out_of_scope ?? [],
      small_max: smallMax,
    });
    call.event('scope.proposed', { size: out.size, questions: out.questions.map((q) => q.id), small_max_usages: smallMax });
    return out;
  });
}

/** Usages a scope answer drops. One reason each: a package filter, then a stop, then deprecated. */
export function usagesOutOfScope(
  usages: readonly Usage[],
  necessityOf: (usageId: string) => 'breaks' | 'deprecated' | null,
  chosen: { targets?: readonly string[]; stopAt?: string; dropDeprecated: boolean },
  binds: (rules: 'full' | 'narrow', usage: Usage) => boolean,
): OutOfScope[] {
  const out: OutOfScope[] = [];
  for (const u of usages) {
    let reason: string | null = null;
    const targets = chosen.targets;
    if (targets && !targets.some((p) => p === '.' || u.file === p || u.file.startsWith(`${p}/`))) reason = `scope: targets=${targets.join(',')}`;
    else if (chosen.stopAt !== undefined && binds('full', u) && !binds('narrow', u)) reason = `scope: stop_at=${chosen.stopAt}`;
    else if (chosen.dropDeprecated && necessityOf(u.id) === 'deprecated') reason = 'scope: include_deprecated=no';
    if (reason) out.push({ usage_id: u.id, written_by: 'scope', reason });
  }
  return out;
}

function answerOf(question: ScopeQuestion, answers: ScopeAnswers): { value: string | string[]; usedDefault: boolean } {
  const given = answers[question.id];
  if (given === undefined) return { value: question.default, usedDefault: true };
  if (question.id === 'targets') {
    if (!Array.isArray(given) || given.length === 0) throw new InputError('bad_answer', 'targets must name at least one offered package');
    const allowed = new Set(question.options.map((o) => o.id));
    for (const id of given) if (!allowed.has(id)) throw new InputError('bad_answer', `targets: ${id} is not one of the offered options`);
    return { value: given, usedDefault: false };
  }
  if (typeof given !== 'string' || !question.options.some((o) => o.id === given)) {
    throw new InputError('bad_answer', `${question.id}: ${String(given)} is not one of the offered options`);
  }
  return { value: given, usedDefault: false };
}

export async function setScope(engine: Engine, raw: unknown): Promise<SetScopeOutput> {
  const parsed = SetScopeInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'set_scope', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const events = listEvents(opened.session.db, opened.run.id);
    if (events.some((e) => e.kind === 'packet.fetched' || e.kind === 'merge.started')) {
      throw new InputError('scope_frozen', 'scope is frozen: a lens packet was fetched or merge_findings has started');
    }
    const stored = getScope(opened.session.db, opened.run.id);
    const facts = factsOf(opened, stored?.small_max ?? DEFAULT_SMALL_MAX);
    for (const key of Object.keys(parsed.data.answers)) {
      if (!facts.questions.some((q) => q.id === key)) throw new InputError('bad_answer', `${key} was not one of the questions offered`);
    }
    const chosen = new Map<string, string | string[]>();
    const defaults: string[] = [];
    for (const q of facts.questions) {
      const a = answerOf(q, parsed.data.answers);
      chosen.set(q.id, a.value);
      if (a.usedDefault) defaults.push(q.id);
    }
    const depth = chosen.get('depth');
    if (typeof depth === 'string' && SIZE_RANK[depth as Size] < SIZE_RANK[facts.size.size]) {
      throw new InputError('bad_answer', 'depth can only move toward full');
    }
    const stop = chosen.get('stop_at');
    if (typeof stop === 'string') checkStopAt(opened.pack.pack, opened.pack.primary.library, stop);
    const targets = chosen.get('targets');
    const narrowed = typeof stop === 'string' ? composeRun(opened.pack, opened.versions, { stopAt: stop, usages: facts.usages }) : facts.composed;
    const rulesOf = (c: PackComposition): ComposedRule[] => c.libraries.flatMap((l) => l.rules);
    const fullRules = rulesOf(facts.composed);
    const narrowRules = rulesOf(narrowed);
    const outOfScope = usagesOutOfScope(
      facts.usages,
      (id) => facts.risks.find((r) => r.usage_id === id)?.necessity ?? null,
      {
        ...(Array.isArray(targets) ? { targets } : {}),
        ...(typeof stop === 'string' ? { stopAt: stop } : {}),
        dropDeprecated: chosen.get('include_deprecated') === 'no',
      },
      (which, u) => (which === 'full' ? fullRules : narrowRules).some((r) => u.match_kind !== null && bindsTo(r.rule.match, u)),
    );
    const answers = Object.fromEntries(chosen);
    const size: Size = depth === 'full' ? 'full' : facts.size.size;
    putScope(opened.session.db, opened.run.id, { answers, defaults, out_of_scope: outOfScope, small_max: stored?.small_max ?? DEFAULT_SMALL_MAX });
    call.event('scope.set', { size, answers, defaults, out_of_scope: outOfScope.length });
    return { run_id: opened.run.id, size, answers, defaults, out_of_scope: outOfScope };
  });
}
