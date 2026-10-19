// The migration size, from the facts only (D8). `none` needs every condition;
// any one of them missing makes it small or full.
import type { ComposedRule } from '../rules/compose.js';
import type { UsageRisk } from '../schema/risk.js';
import type { Size } from '../schema/scope.js';

export const DEFAULT_SMALL_MAX = 10;

export interface SizeInput {
  risks: readonly Pick<UsageRisk, 'unmapped' | 'suggested_severity' | 'rule_id'>[];
  /** Matched usages whose rule names a codemod. */
  codemodCovered: number;
  matched: number;
  unparsed: number;
  unresolved: number;
  skippedByLimit: number;
  peerConflicts: number;
  olderThanCovered: boolean;
  olderThanSupported: boolean;
  smallMax: number;
}

export interface SizeResult {
  size: Size;
  reasons: string[];
}

/** Rules that change behaviour with no syntax change, listed on a `none` plan. */
export function hiddenBehavior(rules: readonly ComposedRule[]): { id: string; title: string }[] {
  return rules
    .filter((r) => r.rule.event === 'changed_behavior' || r.rule.event === 'changed_default')
    .map((r) => ({ id: r.rule.id, title: r.rule.title }));
}

export function computeSize(input: SizeInput): SizeResult {
  const reasons: string[] = [];
  const complete = input.unparsed === 0 && input.unresolved === 0 && input.skippedByLimit === 0;
  if (input.unparsed > 0) reasons.push(`${input.unparsed} file${input.unparsed === 1 ? '' : 's'} did not parse`);
  if (input.unresolved > 0) reasons.push(`${input.unresolved} unresolved dynamic import${input.unresolved === 1 ? '' : 's'}`);
  if (input.skippedByLimit > 0) reasons.push(`${input.skippedByLimit} path${input.skippedByLimit === 1 ? '' : 's'} skipped by a scan limit`);
  if (input.peerConflicts > 0) reasons.push(`${input.peerConflicts} peer dependency conflict${input.peerConflicts === 1 ? '' : 's'}`);
  if (input.olderThanCovered) reasons.push('the installed version is older than the covered range');
  if (input.olderThanSupported) reasons.push('the installed version is older than this pack\'s checked range');
  if (input.matched > 0) reasons.push(`${input.matched} usage${input.matched === 1 ? '' : 's'} match a composed rule`);
  const blocked = !complete || input.peerConflicts > 0 || input.olderThanCovered || input.olderThanSupported || input.matched > 0;
  if (!blocked) {
    return { size: 'none', reasons: ['no usage matches a composed rule and the scan is complete'] };
  }
  const high = input.risks.some((r) => !r.unmapped && (r.suggested_severity === 'high' || r.suggested_severity === 'blocker'));
  const allCodemod = input.matched > 0 && input.codemodCovered === input.matched;
  if (complete && input.matched <= input.smallMax && allCodemod && !high && input.peerConflicts === 0) {
    reasons.push(`every matched usage is covered by a codemod and none is high`);
    return { size: 'small', reasons };
  }
  if (!complete) reasons.push('the scan is not complete, so the size is full');
  if (input.matched > input.smallMax) reasons.push(`more than ${input.smallMax} usages match a rule`);
  if (input.matched > 0 && !allCodemod) reasons.push('a matched usage has no codemod');
  if (high) reasons.push('a matched usage is high or blocker');
  return { size: 'full', reasons };
}
