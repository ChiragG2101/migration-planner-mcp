// Evidence packets (M5). Usage kinds come from the pack, so another pack adds
// no code here. A packet never carries another lens's findings. Scope-excluded
// usages are left out (D16). The byte cap is reported in `truncated`.
import { isEntrypoint, isTestFile, riskOf } from '../analysis/risk.js';
import { symbolOf } from '../docs/format.js';
import { bindsTo } from '../rules/match.js';
import type { ComposedRule, PackComposition } from '../rules/compose.js';
import type { LoadedLibrary } from '../rules/compose.js';
import type { RunDocRow } from '../store/docs.js';
import type { ImportRow } from '../store/usages.js';
import type { FindingLens } from '../schema/finding.js';
import type { Pack } from '../schema/pack.js';
import type { DocQuery, LensPacket, PacketCodemod, PacketRule, PacketScan, PacketTests, Truncation } from '../schema/packet.js';
import type { UsageRisk } from '../schema/risk.js';
import type { ScanResult } from '../schema/scan.js';
import type { Size } from '../schema/scope.js';
import type { Usage } from '../schema/usage.js';
import { PermissionError } from '../security/errors.js';
import { isDenied } from '../security/denyList.js';
import { resolveInside } from '../security/pathBoundary.js';

/** The packet JSON stays within this many characters. Truncation is reported. */
export const PACKET_MAX_CHARS = 100_000;

const BEHAVIOR_EVENTS = new Set(['changed_behavior', 'changed_default']);

export interface PacketInput {
  lens: FindingLens;
  size: Size;
  promptVersion: string;
  runId: string;
  campaignId: string;
  repoId: string;
  repoRoot: string;
  pack: Pack;
  libs: ReadonlyMap<string, LoadedLibrary>;
  composed: PackComposition;
  /** Every usage, including ones the scope excluded. Stored order. */
  usages: readonly Usage[];
  excluded: ReadonlySet<string>;
  imports: readonly ImportRow[];
  scan: ScanResult;
  docs: readonly RunDocRow[];
  maxChars: number;
}

function rulesOf(composed: PackComposition): ComposedRule[] {
  return composed.libraries.flatMap((l) => l.rules);
}

/** Where a rule that binds no in-scope usage is shown. Bound rules follow the usage's pack lens instead. */
function unboundHome(rule: ComposedRule): FindingLens {
  if (rule.rule.event === 'peer_requirement' || rule.rule.match.kind === 'dependency' || rule.rule.match.kind === 'config_key') return 'dependency_build';
  if (BEHAVIOR_EVENTS.has(rule.rule.event) || rule.rule.match.kind === 'file_convention') return 'behavior_runtime';
  return 'api';
}

function packetRule(rule: ComposedRule, usageIds: string[]): PacketRule {
  return {
    id: rule.rule.id,
    library: rule.library,
    title: rule.rule.title,
    event: rule.rule.event,
    necessity: rule.necessity,
    lands_on: rule.lands_on,
    summary: rule.rule.concern,
    default_severity: rule.rule.default_severity,
    codemod: rule.rule.codemod ?? null,
    mapping: rule.rule.mapping,
    verify_hint: rule.rule.verify_hint,
    rollback_hint: rule.rule.rollback_hint,
    doc_topics: [...rule.rule.doc_topics],
    source: rule.rule.source,
    usage_ids: usageIds,
  };
}

function versionsOf(composed: PackComposition, libraryId: string): string[] {
  const lib = composed.libraries.find((l) => l.library === libraryId);
  return lib ? [...new Set([lib.from, lib.to])] : [];
}

function packageOf(libs: ReadonlyMap<string, LoadedLibrary>, libraryId: string): string {
  return libs.get(libraryId)?.library.packages[0] ?? libraryId.split('/')[1] ?? libraryId;
}

function denied(root: string, repoId: string, file: string): string | null {
  try {
    const sp = resolveInside(root, file, repoId);
    return isDenied(sp) ? 'denied' : null;
  } catch (err) {
    if (err instanceof PermissionError) return err.code;
    throw err;
  }
}

function scanOf(scan: ScanResult, usages: readonly Usage[]): PacketScan {
  const dependencies = scan.packages.flatMap((p) =>
    p.dependencies.map((d) => ({ package: p.path, name: d.name, kind: d.kind, declared: d.declared, resolved: d.resolved })),
  );
  const tsconfig = scan.packages
    .filter((p) => p.tsconfig)
    .map((p) => ({ package: p.path, target: p.tsconfig!.target, module: p.tsconfig!.module, chain: [...p.tsconfig!.chain] }));
  const config_files = scan.packages.flatMap((p) =>
    p.entrypoints.filter((e) => e.kind.includes('config')).map((e) => ({ package: p.path, kind: e.kind, path: e.path })),
  );
  const peer_conflicts = usages.filter((u) => u.labels.includes('peer_conflict')).map((u) => ({ usage_id: u.id, file: u.file, symbol: u.symbol }));
  return { dependencies, tsconfig, config_files, peer_conflicts };
}

function testsOf(pack: Pack, composed: PackComposition, scan: ScanResult, usages: readonly Usage[], imports: readonly ImportRow[]): PacketTests {
  const byFile = new Map<string, Set<string>>();
  for (const edge of imports) {
    if (!edge.to_file || !isTestFile(edge.from_file)) continue;
    const set = byFile.get(edge.to_file) ?? new Set<string>();
    set.add(edge.from_file);
    byFile.set(edge.to_file, set);
  }
  const modules = [...new Set(usages.map((u) => u.file).filter((f) => !isTestFile(f)))].sort();
  return {
    setup: scan.packages.map((p) => ({ package: p.path, runners: p.tests.runners.map((r) => r.name), test_script: p.tests.test_script })),
    covered: modules.filter((f) => byFile.has(f)).map((f) => ({ file: f, tests: [...byFile.get(f)!].sort() })),
    uncovered: modules.filter((f) => !byFile.has(f)),
    checks_hint: pack.checks_hint,
    verify_hints: rulesOf(composed)
      .map((r) => ({ rule_id: r.rule.id, verify_hint: r.rule.verify_hint }))
      .sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1)),
  };
}

function symbolsOf(packetRules: readonly PacketRule[], rules: readonly ComposedRule[], composed: PackComposition, libs: ReadonlyMap<string, LoadedLibrary>): DocQuery[] {
  const byId = new Map(rules.map((r) => [r.rule.id, r]));
  const seen = new Set<string>();
  const out: DocQuery[] = [];
  const add = (libraryId: string, symbol: string): void => {
    const pkg = packageOf(libs, libraryId);
    for (const version of versionsOf(composed, libraryId)) {
      const key = `${pkg}\n${version}\n${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ library: pkg, version, symbol });
    }
  };
  // Only composed-rule symbols. A usage symbol can be repo text, and get_migration_docs rejects anything symbolOf did not produce.
  for (const rule of packetRules) {
    const full = byId.get(rule.id);
    if (full) add(full.library, symbolOf(full.rule.match));
  }
  out.sort((a, b) => (a.library === b.library ? (a.version === b.version ? (a.symbol < b.symbol ? -1 : 1) : a.version < b.version ? -1 : 1) : a.library < b.library ? -1 : 1));
  return out;
}

function codemodsOf(packetRules: readonly PacketRule[], libs: ReadonlyMap<string, LoadedLibrary>): PacketCodemod[] {
  const byId = new Map<string, PacketCodemod>();
  for (const rule of packetRules) {
    if (!rule.codemod) continue;
    const notes = libs.get(rule.library)?.library.codemods.find((c) => c.id === rule.codemod)?.notes ?? '';
    const have = byId.get(rule.codemod);
    if (have) {
      have.rule_ids.push(rule.id);
      for (const id of rule.usage_ids) if (!have.usage_ids.includes(id)) have.usage_ids.push(id);
    } else {
      byId.set(rule.codemod, { id: rule.codemod, notes, rule_ids: [rule.id], usage_ids: [...rule.usage_ids] });
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function docsFor(docs: readonly RunDocRow[], rules: readonly PacketRule[], symbols: readonly DocQuery[]): LensPacket['docs'] {
  const topics = new Set<string>([...symbols.map((s) => s.symbol), ...rules.flatMap((r) => r.doc_topics)]);
  return docs
    .filter((d) => topics.has(d.topic))
    .map((d) => ({ doc_id: d.doc_id, library: d.library, version: d.version, topic: d.topic, url: d.url, status: d.status }))
    .sort((a, b) => (a.doc_id < b.doc_id ? -1 : 1));
}

function risksFor(usages: readonly Usage[], rules: readonly ComposedRule[], imports: readonly ImportRow[]): UsageRisk[] {
  const importers = new Map<string, Set<string>>();
  const testers = new Set<string>();
  for (const edge of imports) {
    if (!edge.to_file) continue;
    const set = importers.get(edge.to_file) ?? new Set<string>();
    set.add(edge.from_file);
    importers.set(edge.to_file, set);
    if (isTestFile(edge.from_file)) testers.add(edge.to_file);
  }
  return usages.map((u) => riskOf(u, rules, { fanIn: importers.get(u.file)?.size ?? 0, tested: testers.has(u.file), entrypoint: isEntrypoint(u.file) }));
}

function selectRules(lens: FindingLens, packetUsages: readonly Usage[], inScope: readonly Usage[], composed: PackComposition): PacketRule[] {
  const here = new Set(packetUsages.map((u) => u.id));
  const out: PacketRule[] = [];
  for (const rule of rulesOf(composed)) {
    const bound = inScope.filter((u) => u.match_kind !== null && bindsTo(rule.rule.match, u));
    const mine = bound.filter((u) => here.has(u.id)).map((u) => u.id);
    if (mine.length) out.push(packetRule(rule, mine));
    else if (bound.length === 0 && (lens === 'combined' || unboundHome(rule) === lens)) out.push(packetRule(rule, []));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Builds one lens packet and trims it to `maxChars`, reporting every drop. */
export function buildLensPacket(input: PacketInput): LensPacket {
  const inScope = input.usages.filter((u) => !input.excluded.has(u.id));
  const kinds = new Set(input.pack.usage_kinds.filter((k) => input.lens === 'combined' || k.lens === input.lens).map((k) => k.kind));
  const skipped_denied: LensPacket['skipped_denied'] = [];
  const usages: Usage[] = [];
  for (const usage of inScope) {
    if (!kinds.has(usage.kind)) continue;
    const code = denied(input.repoRoot, input.repoId, usage.file);
    if (code) skipped_denied.push({ usage_id: usage.id, code });
    else usages.push(usage);
  }
  let rules = selectRules(input.lens, usages, inScope, input.composed);
  const unbound = new Set(rules.filter((r) => r.usage_ids.length === 0).map((r) => r.id));
  const wantsScan = input.lens === 'dependency_build' || input.lens === 'combined';
  const wantsRisks = input.lens === 'behavior_runtime' || input.lens === 'combined';
  const wantsTests = input.lens === 'verification' || input.lens === 'combined';
  const dropped = { usages: 0, rules: 0, symbols: 0 };
  let note: string | null = null;

  const assemble = (symbolList: DocQuery[]): LensPacket => ({
    run_id: input.runId,
    campaign_id: input.campaignId,
    repo_id: input.repoId,
    lens: input.lens,
    size: input.size,
    prompt_version: input.promptVersion,
    usages,
    rules,
    codemods: codemodsOf(rules, input.libs),
    docs: docsFor(input.docs, rules, symbolList),
    symbols: symbolList,
    risks: wantsRisks ? risksFor(usages, rulesOf(input.composed), input.imports) : [],
    scan: wantsScan ? scanOf(input.scan, inScope) : null,
    tests: wantsTests ? testsOf(input.pack, input.composed, input.scan, inScope, input.imports) : null,
    skipped_denied,
    truncated: null,
  });

  let symbols = symbolsOf(rules, rulesOf(input.composed), input.composed, input.libs);
  let packet = assemble(symbols);
  // Room for the truncated object, which is attached after the cuts.
  const tooBig = (): boolean => JSON.stringify(packet).length + 160 > input.maxChars;

  while (tooBig() && usages.length > 0) {
    const droppedUsage = usages.pop()!;
    dropped.usages += 1;
    for (const rule of rules) rule.usage_ids = rule.usage_ids.filter((id) => id !== droppedUsage.id);
    rules = rules.filter((r) => r.usage_ids.length > 0 || unbound.has(r.id));
    symbols = symbolsOf(rules, rulesOf(input.composed), input.composed, input.libs);
    packet = assemble(symbols);
  }
  while (tooBig() && packet.symbols.length > 0) {
    packet.symbols.pop();
    dropped.symbols += 1;
    packet.docs = docsFor(input.docs, rules, packet.symbols);
  }
  while (tooBig() && rules.length > 0) {
    rules.pop();
    dropped.rules += 1;
    packet = assemble(packet.symbols);
  }
  if (tooBig() && packet.risks.length > 0) {
    packet.risks = [];
    note = 'cleared risks to fit the packet limit';
  }
  if (tooBig() && packet.scan) {
    packet.scan = { dependencies: [], tsconfig: [], config_files: [], peer_conflicts: [] };
    note = 'cleared scan facts to fit the packet limit';
  }
  if (tooBig() && packet.tests) {
    packet.tests = { ...packet.tests, verify_hints: [], covered: [], uncovered: [] };
    note = 'cleared test details to fit the packet limit';
  }
  if (tooBig()) note = 'packet header exceeds the limit';
  const truncated: Truncation | null =
    dropped.usages || dropped.rules || dropped.symbols || note ? { usages: dropped.usages, rules: dropped.rules, symbols: dropped.symbols, note } : null;
  packet.truncated = truncated;
  return packet;
}
