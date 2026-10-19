// INV-37: range composition, table-driven on fake libraries in both schemes.
// The same table runs on a semver library counted by majors and a PEP 440
// library counted by X.Y releases; release i is `i` and `1.i` respectively,
// and a finer version i.f is `i.f` and `1.i.f`.
import { describe, expect, it } from 'vitest';
import { composeLibrary, composePack, type LoadedLibrary } from '../../src/rules/compose.js';
import type { LaterEvent, Library, ReviewedRule, RuleEvent } from '../../src/schema/knowledge.js';
import type { Pack } from '../../src/schema/pack.js';

type Scheme = 'semver' | 'pep440';
const rel = (s: Scheme, i: number): string => (s === 'semver' ? `${i}` : `1.${i}`);
const ver = (s: Scheme, i: number, f = 0, p = 0): string => (s === 'semver' ? `${i}.${f}.${p}` : `1.${i}.${f}`);
const fine = (s: Scheme, i: number, f: number): string => (s === 'semver' ? `${i}.${f}` : `1.${i}.${f}`);

function library(s: Scheme, id: string, covered: number): Library {
  return {
    id,
    ecosystem: s === 'semver' ? 'npm' : 'pypi',
    packages: [id.split('/')[1]!],
    language: s === 'semver' ? 'ts' : 'python',
    version_scheme: s,
    release_unit: s === 'semver' ? 'major' : 'minor',
    covered_from: rel(s, covered),
    doc_sources: ['https://example.org/docs/'],
    release_notes: { fetch: 'https://example.org/{version}.md', page: 'https://example.org/docs/{version}', format: 'md', sections: [{ heading: '*' }], skip: [] },
    codemods: [],
  };
}

function rule(id: string, event: RuleEvent, over: Partial<ReviewedRule> = {}): ReviewedRule {
  return {
    id,
    title: id,
    event,
    source: 'https://example.org/docs/x',
    status: 'reviewed',
    match: { kind: 'call', module: 'm', name: 'f' },
    concern: 'c',
    default_severity: 'medium',
    mapping: { from: 'a', to: 'b' },
    no_equivalent: false,
    notes: '',
    verify_hint: 'v',
    rollback_hint: 'r',
    doc_topics: ['t'],
    ...over,
  } as ReviewedRule;
}

/** A rule defined in release `at` (optionally at a finer version), with later events. */
interface Spec {
  id: string;
  first: [RuleEvent, number, number?];
  later?: [Exclude<RuleEvent, 'peer_requirement'>, number, number?][];
  replacement_since?: number;
}

function build(s: Scheme, specs: Spec[], covered = 1): LoadedLibrary {
  const releases = new Map<number, { rules: ReviewedRule[]; events: LaterEvent[] }>();
  const at = (i: number) => {
    if (!releases.has(i)) releases.set(i, { rules: [], events: [] });
    return releases.get(i)!;
  };
  for (const sp of specs) {
    const [event, i, f] = sp.first;
    at(i).rules.push(
      rule(`fake/${sp.id}`, event, {
        ...(f !== undefined ? { version: fine(s, i, f) } : {}),
        ...(sp.replacement_since !== undefined ? { replacement_since: rel(s, sp.replacement_since) } : {}),
      }),
    );
    for (const [e, j, g] of sp.later ?? []) at(j).events.push({ rule: `fake/${sp.id}`, event: e, ...(g !== undefined ? { version: fine(s, j, g) } : {}) });
  }
  return {
    library: library(s, s === 'semver' ? 'npm/fake' : 'pypi/fake', covered),
    releases: [...releases].sort(([a], [b]) => a - b).map(([i, r]) => ({ release: rel(s, i), ...r })),
  };
}

const specs: Spec[] = [
  { id: 'at-s', first: ['removed', 2] },
  { id: 'at-t', first: ['removed', 4] },
  { id: 'dep-in-range-removed-after-t', first: ['deprecated', 3], later: [['removed', 5]] },
  { id: 'dep-before-s-removed-in-range', first: ['deprecated', 1], later: [['removed', 3]] },
  { id: 'dep-before-s-not-removed', first: ['deprecated', 1], later: [['removed', 5]] },
  { id: 'replacement-at-s', first: ['deprecated', 3], replacement_since: 2 },
  { id: 'replacement-after-s', first: ['deprecated', 3], replacement_since: 3 },
  { id: 'replacement-absent', first: ['changed_default', 3] },
  { id: 'patch-in-s-release', first: ['changed_behavior', 2, 5] },
  { id: 'patch-after-t', first: ['changed_behavior', 4, 1] },
  { id: 'renamed', first: ['renamed', 3] },
];

describe.each(['semver', 'pep440'] as const)('composition (%s)', (s) => {
  // S = release 2 at x.0.0 (pep440 1.2.0); T = release 4 at x.0.0 (pep440 1.4.0).
  const result = composeLibrary(build(s, specs), ver(s, 2), { version: ver(s, 4) });
  const byId = new Map(result.rules.map((r) => [r.rule.id.slice('fake/'.length), r]));

  it('excludes an event exactly at S and includes one exactly at T', () => {
    expect(byId.has('at-s')).toBe(false);
    expect(byId.get('at-t')?.necessity).toBe('breaks');
  });

  it('a rule deprecated in range and removed after T is deprecated', () => {
    expect(byId.get('dep-in-range-removed-after-t')?.necessity).toBe('deprecated');
  });

  it('one deprecated before S and removed in range breaks', () => {
    expect(byId.get('dep-before-s-removed-in-range')?.necessity).toBe('breaks');
    expect(byId.get('dep-before-s-removed-in-range')?.in_range.map((e) => e.event)).toEqual(['removed']);
  });

  it('one deprecated before S and not removed by T is not included', () => {
    expect(byId.has('dep-before-s-not-removed')).toBe(false);
  });

  it('replacement_since at S lands on source, after S or absent on target', () => {
    expect(byId.get('replacement-at-s')?.lands_on).toBe('source');
    expect(byId.get('replacement-after-s')?.lands_on).toBe('target');
    expect(byId.get('replacement-absent')?.lands_on).toBe('target');
  });

  it('a patch-level event after S inside S’s release applies; one after T does not', () => {
    expect(byId.get('patch-in-s-release')?.necessity).toBe('breaks');
    expect(byId.has('patch-after-t')).toBe(false);
  });

  it('renamed and changed_default break', () => {
    expect(byId.get('renamed')?.necessity).toBe('breaks');
    expect(byId.get('replacement-absent')?.necessity).toBe('breaks');
  });

  it('a stop_at release unit includes every version of that release and nothing after it', () => {
    const stopped = composeLibrary(build(s, specs), ver(s, 2), { stop_at: rel(s, 3) });
    const ids = stopped.rules.map((r) => r.rule.id.slice('fake/'.length));
    expect(ids).toContain('renamed');
    expect(ids).not.toContain('at-t');
    const full = composeLibrary(build(s, specs), ver(s, 2), { stop_at: rel(s, 4) });
    expect(full.rules.map((r) => r.rule.id.slice('fake/'.length))).toContain('patch-after-t');
  });

  it('gives the not-checked note when S is older than covered_from, and none otherwise', () => {
    expect(composeLibrary(build(s, specs, 3), ver(s, 2), { version: ver(s, 4) }).notes.map((n) => n.kind)).toEqual(['not_checked_before']);
    expect(result.notes).toEqual([]);
  });
});

describe('both schemes agree', () => {
  it('derives the same necessity and lands_on for equivalent inputs', () => {
    const summary = (s: Scheme) =>
      composeLibrary(build(s, specs), ver(s, 2), { version: ver(s, 4) }).rules.map((r) => [r.rule.id, r.necessity, r.lands_on]);
    expect(summary('semver')).toEqual(summary('pep440'));
    expect(summary('semver').length).toBeGreaterThan(5);
  });
});

describe('pack composition', () => {
  const primary = (): LoadedLibrary => ({
    library: { ...library('semver', 'npm/main', 2), packages: ['main'] },
    releases: [
      {
        release: '3',
        rules: [
          rule('main/needs-peer-19', 'peer_requirement', { requires: { library: 'npm/peer', range: '>=19' }, match: { kind: 'file_convention', glob: 'app/**' } }),
          rule('main/needs-peer-19-2', 'peer_requirement', { requires: { library: 'npm/peer', range: '>=19.2' }, match: { kind: 'call', module: 'main', name: 'x' } }),
        ],
        events: [],
      },
    ],
  });
  const peer = (): LoadedLibrary => ({
    library: { ...library('semver', 'npm/peer', 18), packages: ['peer', 'peer-dom'] },
    releases: [
      { release: '19', rules: [rule('peer/removed-in-19', 'removed')], events: [] },
      { release: '20', rules: [rule('peer/removed-in-20', 'removed')], events: [] },
    ],
  });
  const pack: Pack = {
    name: 'fake',
    version: '0.1.0',
    kind: 'upgrade',
    language: 'ts',
    trigger: 'Use when testing.',
    libraries: [
      { id: 'npm/main', role: 'primary' },
      { id: 'npm/peer', role: 'companion' },
    ],
    supported: { from: '2', to: '3' },
    usage_adapter: 'fake',
    usage_kinds: [{ kind: 'x', lens: 'api' }],
    staging: 'leaf_first',
    checks_hint: 'run checks',
    references: [],
    seeded: 'fake',
  };
  const libs = () => new Map([['npm/main', primary()], ['npm/peer', peer()]]);

  it('composes the companion to the lowest version every requirement allows; the stricter range wins', () => {
    const c = composePack(pack, libs(), { installed: { 'npm/main': '2.5.0', 'npm/peer': '18.3.1' }, target: '3.1.0' });
    expect(c.targets).toEqual({ main: '3.1.0', peer: '19.2.0', 'peer-dom': '19.2.0' });
    const peerComp = c.libraries.find((l) => l.library === 'npm/peer')!;
    expect(peerComp.to).toBe('19.2.0');
    expect(peerComp.rules.map((r) => r.rule.id)).toEqual(['peer/removed-in-19']);
  });

  it('applies a conditional requirement whose match finds nothing, with the may-not-be-needed note', () => {
    const c = composePack(pack, libs(), {
      installed: { 'npm/main': '2.5.0', 'npm/peer': '18.3.1' },
      target: '3.1.0',
      matched: (r) => r.id !== 'main/needs-peer-19-2',
    });
    expect(c.targets.peer).toBe('19.2.0');
    expect(c.notes.filter((n) => n.kind === 'requirement_may_not_be_needed').map((n) => n.rule_id)).toEqual(['main/needs-peer-19-2']);
  });

  it('notes an installed version older than supported.from', () => {
    const c = composePack(pack, libs(), { installed: { 'npm/main': '1.9.0', 'npm/peer': '18.3.1' }, target: '3.0.0' });
    expect(c.notes.map((n) => n.kind)).toContain('older_than_supported');
    expect(c.notes.map((n) => n.kind)).toContain('not_checked_before');
  });

  it('skips a companion that already satisfies, and notes one with no installed version', () => {
    const ok = composePack(pack, libs(), { installed: { 'npm/main': '2.5.0', 'npm/peer': '19.3.0' }, target: '3.0.0' });
    expect(ok.libraries.map((l) => l.library)).toEqual(['npm/main']);
    expect(ok.notes.map((n) => n.kind)).toContain('companion_not_needed');
    const unknown = composePack(pack, libs(), { installed: { 'npm/main': '2.5.0', 'npm/peer': null }, target: '3.0.0' });
    expect(unknown.notes.map((n) => n.kind)).toContain('companion_installed_unknown');
    expect(unknown.targets.peer).toBe('19.2.0');
  });

  it('refuses a target newer than supported.to, a pre-release, and a stop_at outside the range', () => {
    const installed = { 'npm/main': '2.5.0', 'npm/peer': '18.3.1' };
    expect(() => composePack(pack, libs(), { installed, target: '4.0.0' })).toThrow('target 4.0.0 is newer than this pack has been checked for (up to 3)');
    expect(() => composePack(pack, libs(), { installed, target: '3.0.0-canary.1' })).toThrow('pre-release versions not supported in v0.1');
    expect(() => composePack(pack, libs(), { installed, target: '3.9.9' })).not.toThrow();
    expect(() => composePack(pack, libs(), { installed, target: '3.0.0', stop_at: '4' })).toThrow(/stop_at/);
    expect(() => composePack(pack, libs(), { installed, target: '3.0.0', stop_at: '3.1' })).toThrow(/stop_at/);
  });
});
