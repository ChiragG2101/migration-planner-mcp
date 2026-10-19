// Each condition that keeps a migration from being `none`, and the two that
// turn `small` into `full`.
import { describe, expect, it } from 'vitest';
import { computeSize, hiddenBehavior, type SizeInput } from '../../src/analysis/sizing.js';
import type { ComposedRule } from '../../src/rules/compose.js';

const none: SizeInput = {
  risks: [],
  codemodCovered: 0,
  matched: 0,
  unparsed: 0,
  unresolved: 0,
  skippedByLimit: 0,
  peerConflicts: 0,
  olderThanCovered: false,
  olderThanSupported: false,
  smallMax: 10,
};

const small = (over: Partial<SizeInput> = {}): SizeInput => ({
  ...none,
  risks: [{ unmapped: false, suggested_severity: 'low', rule_id: 'next/x' }],
  codemodCovered: 1,
  matched: 1,
  ...over,
});

describe('sizing', () => {
  it('is none only when nothing matched and the scan is complete', () => {
    expect(computeSize(none)).toMatchObject({ size: 'none' });
  });

  it.each([
    ['an unparsed file', { unparsed: 1 }],
    ['an unresolved dynamic import', { unresolved: 1 }],
    ['a path skipped by a limit', { skippedByLimit: 1 }],
    ['a peer conflict', { peerConflicts: 1 }],
    ['an install older than covered_from', { olderThanCovered: true }],
    ['an install older than supported.from', { olderThanSupported: true }],
    ['one matched usage', { matched: 1, risks: [{ unmapped: false, suggested_severity: 'low', rule_id: 'next/x' }], codemodCovered: 0 }],
  ] as const)('a %s is not none', (_name, over) => {
    expect(computeSize({ ...none, ...over }).size).not.toBe('none');
  });

  it('is small when every matched usage has a codemod and none is high', () => {
    expect(computeSize(small()).size).toBe('small');
    expect(computeSize(small({ matched: 10, codemodCovered: 10, risks: Array.from({ length: 10 }, () => ({ unmapped: false, suggested_severity: 'medium' as const, rule_id: 'next/x' })) })).size).toBe('small');
  });

  it('is full when a matched usage has no codemod or is high', () => {
    expect(computeSize(small({ codemodCovered: 0 })).size).toBe('full');
    expect(computeSize(small({ risks: [{ unmapped: false, suggested_severity: 'high', rule_id: 'next/x' }] })).size).toBe('full');
    expect(computeSize(small({ risks: [{ unmapped: false, suggested_severity: 'blocker', rule_id: 'next/x' }] })).size).toBe('full');
    expect(computeSize(small({ matched: 11, codemodCovered: 11 })).size).toBe('full');
    expect(computeSize(small({ unparsed: 1 })).size).toBe('full');
  });

  it('lists behaviour rules as hidden only for the caller to show on a none plan', () => {
    const rules = [
      { rule: { id: 'next/fetch', title: 'fetch is uncached', event: 'changed_default' } },
      { rule: { id: 'next/cookies', title: 'cookies are async', event: 'changed_behavior' } },
      { rule: { id: 'next/font', title: 'font moved', event: 'removed' } },
    ] as unknown as ComposedRule[];
    expect(hiddenBehavior(rules).map((r) => r.id)).toEqual(['next/fetch', 'next/cookies']);
  });
});
