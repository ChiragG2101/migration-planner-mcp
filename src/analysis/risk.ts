// Deterministic risk for one usage (M3 task 11). The suggested severity starts
// at the matched rule's default and only moves up. A codemod is recorded, and
// it does not lower the severity: the mechanical edit still needs a verify step.
import type { ComposedRule } from '../rules/compose.js';
import { bindsTo } from '../rules/match.js';
import type { Severity } from '../schema/knowledge.js';
import type { UsageRisk } from '../schema/risk.js';
import type { Usage } from '../schema/usage.js';

const RANK: readonly Severity[] = ['info', 'low', 'medium', 'high', 'blocker'];
const atLeast = (a: Severity, b: Severity): Severity => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

export interface RiskContext {
  /** Distinct files that import the file containing the usage. */
  fanIn: number;
  /** A test file imports the file containing the usage. */
  tested: boolean;
  entrypoint: boolean;
}

export const isEntrypoint = (file: string): boolean =>
  /(^|\/)middleware\.(js|jsx|ts|tsx|mjs)$/.test(file) || /(^|\/)(page|layout|route)\.(js|jsx|ts|tsx|mjs)$/.test(file);

export const isTestFile = (file: string): boolean => /(^|\/)(__tests__|tests)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

const ASYNC_KINDS = new Set(['request_api', 'request_props']);
const BEHAVIOR_EVENTS = new Set(['changed_behavior', 'changed_default']);

/** The risk for one usage against the rules that bind it. No rule binds: unmapped, raised only by a peer conflict. */
export function riskOf(usage: Usage, rules: readonly ComposedRule[], ctx: RiskContext): UsageRisk {
  const matched = rules.filter((r) => usage.match_kind !== null && bindsTo(r.rule.match, usage));
  const rule = matched.sort((a, b) => RANK.indexOf(b.rule.default_severity) - RANK.indexOf(a.rule.default_severity))[0];
  const signals: UsageRisk['signals'] = [];
  let severity: Severity = rule ? rule.rule.default_severity : 'info';
  if (!rule) signals.push({ name: 'unmapped', detail: 'no composed rule matched this usage' });
  else {
    signals.push({ name: 'rule', detail: `${rule.rule.id} (${rule.necessity}, default ${rule.rule.default_severity}): ${rule.rule.title}` });
    if (rule.rule.codemod) signals.push({ name: 'codemod', detail: `${rule.rule.codemod} covers the mechanical edit; the usage still needs a verify step` });
    if (rule.rule.no_equivalent) {
      severity = atLeast(severity, 'high');
      signals.push({ name: 'no_equivalent', detail: 'the target has no equivalent for this usage' });
    }
    if (BEHAVIOR_EVENTS.has(rule.rule.event)) {
      severity = atLeast(severity, 'high');
      signals.push({ name: 'behavior', detail: 'a behaviour change can be wrong without a syntax error' });
    }
  }
  if (usage.kind === 'cache_api' || usage.kind === 'fetch_call') {
    severity = atLeast(severity, 'high');
    signals.push({ name: 'behavior', detail: 'a caching change can be wrong without a syntax error' });
  }
  if (usage.kind === 'internal_import') {
    severity = atLeast(severity, 'medium');
    signals.push({ name: 'internal', detail: 'an import of a framework internal, whose path can change in a major' });
  }
  if (usage.kind === 'react_types') {
    severity = atLeast(severity, 'medium');
    signals.push({ name: 'types', detail: 'a React type the upgrade changes' });
  }
  if (rule?.rule.event === 'removed' && RANK.indexOf(severity) < RANK.indexOf('medium')) {
    severity = 'medium';
    signals.push({ name: 'removed', detail: 'a removal is at least medium' });
  }
  if (usage.via.length > 0) {
    signals.push({ name: 'indirect', detail: `reached through ${usage.via.length} re-export or wrapper hop${usage.via.length === 1 ? '' : 's'}` });
    if (ASYNC_KINDS.has(usage.kind)) {
      severity = atLeast(severity, 'high');
      signals.push({ name: 'sync_to_async', detail: 'an async request API used through a helper' });
    }
  } else if (ASYNC_KINDS.has(usage.kind)) {
    signals.push({ name: 'sync_to_async', detail: 'an async request API' });
    severity = atLeast(severity, 'high');
  }
  if (usage.labels.includes('peer_conflict')) {
    severity = atLeast(severity, 'blocker');
    signals.push({ name: 'peer_conflict', detail: 'a dependency allows no version the upgrade needs' });
  }
  if (usage.confidence === 'heuristic') signals.push({ name: 'heuristic', detail: 'the match is heuristic' });
  signals.push({ name: 'fan_in', detail: `${ctx.fanIn} file${ctx.fanIn === 1 ? '' : 's'} import this file` });
  if (ctx.fanIn >= 5) severity = atLeast(severity, 'medium');
  if (ctx.entrypoint) signals.push({ name: 'entrypoint', detail: 'the file is a page, layout, route or middleware' });
  signals.push({ name: 'tests', detail: ctx.tested ? 'a test file imports this file' : 'no test file imports this file' });
  return {
    usage_id: usage.id,
    file: usage.file,
    line: usage.line_start,
    kind: usage.kind,
    symbol: usage.symbol,
    rule_id: rule?.rule.id ?? null,
    necessity: rule?.necessity ?? null,
    unmapped: !rule,
    suggested_severity: severity,
    signals,
  };
}
