// "No core changes" allowlist unit tests (M10 Tests: No core changes). Feeds
// synthetic data to the pure core (scripts/lib/coreUntouched.ts), mirroring
// test/unit/eval/addOnly.test.ts. Every planted change in the plan's test list
// fails; a clean Django-shaped pack diff (including completing a pending M0
// case with only notes/checks changed) passes. The wrapper's derivations are
// pure functions here, so this file also tests them directly (round-1 review
// must-fix 3, round-2 must-fix B).
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkCoreUntouched,
  coverageGapsProblems,
  deriveCaseState,
  inAllowedArea,
  isPackPR,
  ownedPacks,
  numstatChangedLines,
  pinnedDiff,
  nonMutableKeysChanged,
  knowledgePrefix,
  newAdapterFiles,
  ratchetExistingEntryChanged,
  readmeExistingLineTouched,
  REGISTRY_FILE,
  type CoreUntouchedInput,
  type CaseMeta,
  type PathChange,
} from '../../scripts/lib/coreUntouched.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ch = (path: string, kind: PathChange['kind'] = 'modified'): PathChange => ({ path, kind });

const djangoMeta: CaseMeta = { pack: 'django-upgrade', hadRuns: false, existedOnBase: true, existsAtHead: true };
const nextMeta: CaseMeta = { pack: 'nextjs-upgrade', hadRuns: true, existedOnBase: true, existsAtHead: true };

const base = (over: Partial<CoreUntouchedInput>): CoreUntouchedInput => ({
  changes: [],
  ownPacks: new Set(['django-upgrade']),
  ownPackLibraries: new Set(['pypi/django']),
  ownSeededRepos: new Set(['django-tricky']),
  caseMeta: new Map<string, CaseMeta>([
    ['django-ror-api-548', djangoMeta],
    ['nextjs-couchers-web-9893', nextMeta],
  ]),
  casesRemoved: new Set(),
  completions: new Map(),
  readmeExistingLineTouched: false,
  ratchetExistingEntryChanged: false,
  registryAdded: 0,
  registryRemoved: 0,
  newAdapterFiles: [],
  coverageGaps: null,
  ...over,
});

const PASS: readonly string[] = [];

describe('pure derivations (round-1 must-fix 3: the wrapper logic is tested here)', () => {
  it('isPackPR is true only when packs/ or knowledge/ changed', () => {
    expect(isPackPR([ch('packs/django-upgrade/pack.json', 'added')])).toBe(true);
    expect(isPackPR([ch('knowledge/pypi/django/library.json', 'added')])).toBe(true);
    expect(isPackPR([ch('docs/design.md'), ch('scripts/x.ts')])).toBe(false);
  });

  it('ownedPacks collects the pack dirs under packs/', () => {
    expect([...ownedPacks([ch('packs/django-upgrade/pack.json', 'added'), ch('packs/django-upgrade/SKILL.md', 'added')])]).toEqual(['django-upgrade']);
    expect([...ownedPacks([ch('packs/a/pack.json'), ch('packs/b/pack.json')])].sort()).toEqual(['a', 'b']);
    expect([...ownedPacks([ch('knowledge/pypi/django/x.json', 'added')])]).toEqual([]);
  });

  it('numstatChangedLines accepts only a pure addition; a single-line replacement fails', () => {
    expect(numstatChangedLines(1, 0)).toBe(1); // one added line
    expect(numstatChangedLines(0, 0)).toBe(0);
    expect(numstatChangedLines(2, 0)).toBe(2); // two added lines
    expect(numstatChangedLines(1, 1)).toBe(Number.POSITIVE_INFINITY); // a single-line replacement
    expect(numstatChangedLines(2, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(numstatChangedLines(Number.POSITIVE_INFINITY, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('readmeExistingLineTouched is true when any line was removed', () => {
    expect(readmeExistingLineTouched(0)).toBe(false);
    expect(readmeExistingLineTouched(1)).toBe(true);
    expect(readmeExistingLineTouched(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('newAdapterFiles keeps only added adapter files, not index.ts, registry.ts or an edit', () => {
    const files = newAdapterFiles([
      ch('src/analysis/usages/django.ts', 'added'),
      ch('src/analysis/usages/nextjs.ts', 'modified'),
      ch('src/analysis/usages/index.ts', 'added'),
      ch(REGISTRY_FILE, 'added'),
      ch('src/analysis/usages/flask.ts', 'deleted'),
    ]);
    expect(files).toEqual(['src/analysis/usages/django.ts']);
  });

  it('ratchetExistingEntryChanged compares base entries as JSON and ignores a new key', () => {
    const baseRatchet = { 'next-tricky': { overall: 1 } };
    expect(ratchetExistingEntryChanged(baseRatchet, { 'next-tricky': { overall: 1 }, 'django-tricky': { overall: 0.5 } })).toBe(false);
    expect(ratchetExistingEntryChanged(baseRatchet, { 'next-tricky': { overall: 0.9 } })).toBe(true);
    expect(ratchetExistingEntryChanged(baseRatchet, {})).toBe(true);
    expect(ratchetExistingEntryChanged(null, { 'django-tricky': { overall: 1 } })).toBe(false);
  });

  it('deriveCaseState reports removal only when the case.json existed on the base and is gone at HEAD', () => {
    const present = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade' }, { pack: 'django-upgrade' }, true, true, false, []);
    expect(present.removed).toBe(false);
    expect(present.meta).toEqual({ pack: 'django-upgrade', hadRuns: false, existedOnBase: true, existsAtHead: true });
    const gone = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade' }, null, true, false, false, [ch('eval/cases/django-ror-api-548/case.json', 'deleted')]);
    expect(gone.removed).toBe(true);
    expect(gone.meta.pack).toBe('django-upgrade');
    expect(gone.completion).toBeNull();
  });

  it('deriveCaseState treats a notes-only edit of a pending case as a completion, and a case with base runs as not one', () => {
    const changes = [ch('eval/cases/django-ror-api-548/case.json', 'modified')];
    const done = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade', notes: 'a', target: { version: '4.2' } }, { pack: 'django-upgrade', notes: 'b', target: { version: '4.2' } }, true, true, false, changes);
    expect(done.completion).toEqual({ pinnedChanged: [], otherChanged: [] });
    const pinned = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade', target: { version: '4.2' } }, { pack: 'django-upgrade', target: { version: '9.9' } }, true, true, false, changes);
    expect(pinned.completion?.pinnedChanged).toEqual(['target']);
    const hadRuns = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade', notes: 'a' }, { pack: 'django-upgrade', notes: 'b' }, true, true, true, changes);
    expect(hadRuns.completion).toBeNull();
    const untouched = deriveCaseState('django-ror-api-548', { pack: 'django-upgrade' }, { pack: 'django-upgrade', notes: 'b' }, true, true, false, [ch('eval/cases/django-ror-api-548/truth.json', 'added')]);
    expect(untouched.completion).toBeNull();
  });

  it('coverageGapsProblems keeps other packs entries and lets this pack add or remove its own', () => {
    const baseGaps = ['nextjs-upgrade: a gap', 'django-upgrade: pending until the Django pack lands'];
    expect(coverageGapsProblems(baseGaps, ['nextjs-upgrade: a gap'], 'django-upgrade')).toEqual([]);
    expect(coverageGapsProblems(baseGaps, ['nextjs-upgrade: a gap', 'django-upgrade: settings covered'], 'django-upgrade')).toEqual([]);
    const dropped = coverageGapsProblems(baseGaps, ['django-upgrade: pending until the Django pack lands'], 'django-upgrade');
    expect(dropped.some((m) => m.includes('not owned by this pack') && m.includes('nextjs-upgrade: a gap'))).toBe(true);
    expect(coverageGapsProblems(baseGaps, [], 'django-upgrade').some((m) => m.includes('nextjs-upgrade: a gap'))).toBe(true);
    expect(coverageGapsProblems(baseGaps, {}, 'django-upgrade')).toEqual(['eval/cases/coverage-gaps.json: base and HEAD must both be a JSON array of strings (fail closed)']);
    expect(coverageGapsProblems('nope', baseGaps, 'django-upgrade')).toEqual(['eval/cases/coverage-gaps.json: base and HEAD must both be a JSON array of strings (fail closed)']);
    expect(coverageGapsProblems(baseGaps, [1, 2], 'django-upgrade')).toEqual(['eval/cases/coverage-gaps.json: base and HEAD must both be a JSON array of strings (fail closed)']);
  });

  it('pinnedDiff lists only changed pinned fields', () => {
    expect(pinnedDiff({ id: 'x', notes: 'a' }, { id: 'x', notes: 'b' })).toEqual([]);
    expect(pinnedDiff({ target: { version: '4.2' } }, { target: { version: '9.9' } })).toEqual(['target']);
    expect(pinnedDiff(null, { id: 'x' })).toEqual([]);
  });

  it('nonMutableKeysChanged flags any key other than notes/checks', () => {
    expect(nonMutableKeysChanged({ notes: 'a', checks: {} }, { notes: 'b', checks: { x: 1 } })).toEqual([]);
    expect(nonMutableKeysChanged({ extra: 1 }, { extra: 2 })).toEqual(['extra']);
    expect(nonMutableKeysChanged({ notes: 'a' }, { notes: 'a', newfield: 7 })).toEqual(['newfield']);
  });

  it('knowledgePrefix maps a library id to its knowledge folder', () => {
    expect(knowledgePrefix('npm/next')).toBe('knowledge/npm/next/');
    expect(knowledgePrefix('pypi/django')).toBe('knowledge/pypi/django/');
  });
});

describe('inAllowedArea (round-1 must-fix 2: the allowlist is as tight as the definition)', () => {
  const own = new Set(['django-upgrade']);
  const libs = new Set(['pypi/django']);
  const seeded = new Set(['django-tricky']);
  const allowed = (p: string): boolean => inAllowedArea(p, own, libs, seeded);

  it('allows the owned pack, its libraries, its seeded repo, and data/docs/plugin', () => {
    expect(allowed('packs/django-upgrade/pack.json')).toBe(true);
    expect(allowed('knowledge/pypi/django/library.json')).toBe(true);
    expect(allowed('eval/seeded/django-tricky/ground_truth.json')).toBe(true);
    expect(allowed('eval/seeded/recall.md')).toBe(true);
    expect(allowed('eval/seeded/ratchet.json')).toBe(true);
    expect(allowed(REGISTRY_FILE)).toBe(true);
    expect(allowed('src/analysis/usages/django.ts')).toBe(true);
    expect(allowed('eval/cases/README.md')).toBe(true);
    expect(allowed('eval/cases/coverage-gaps.json')).toBe(true);
    expect(allowed('docs/design.md')).toBe(true);
    expect(allowed('plugin/skills/django-upgrade/SKILL.md')).toBe(true);
    expect(allowed('test/unit/usages/django.test.ts')).toBe(true);
  });

  it('rejects scoring code, another pack, foreign knowledge, foreign seeded, index.ts, scripts, prompts', () => {
    expect(allowed('eval/seeded/recall.ts')).toBe(false); // scoring code (H1)
    expect(allowed('eval/seeded/next-tricky/ground_truth.json')).toBe(false); // another pack's seeded (H6)
    expect(allowed('packs/nextjs-upgrade/pack.json')).toBe(false); // another pack (H3)
    expect(allowed('knowledge/npm/next/library.json')).toBe(false); // foreign library (H4)
    expect(allowed('src/analysis/usages/index.ts')).toBe(false); // engine wiring
    expect(allowed('eval/runner.ts')).toBe(false); // scoring code
    expect(allowed('scripts/lint-packs.ts')).toBe(false);
    expect(allowed('prompts/plan_migration.v1.md')).toBe(false);
  });

  it('an adapter-shaped path is an allowed area, but editing an existing one fails the full check (H2)', () => {
    // The area gate permits an adapter-shaped file; the add-vs-edit distinction
    // is enforced by checkCoreUntouched, not inAllowedArea.
    expect(allowed('src/analysis/usages/adapter.ts')).toBe(true);
    expect(allowed('src/analysis/usages/nextjs.ts')).toBe(true);
    const edited = checkCoreUntouched(base({ changes: [ch('src/analysis/usages/adapter.ts', 'modified')] }));
    expect(edited.some((m) => m.includes('existing usage adapter changed'))).toBe(true);
  });
});

describe('a clean Django-shaped pack diff passes', () => {
  it('adapter + one registry line + knowledge + pack + new case + runs + completion + seeded + regenerated outputs', () => {
    const changes: PathChange[] = [
      ch('src/analysis/usages/django.ts', 'added'),
      ch(REGISTRY_FILE, 'modified'), // one added registry line
      ch('knowledge/pypi/django/library.json', 'added'),
      ch('knowledge/pypi/django/releases/4.2.json', 'added'),
      ch('packs/django-upgrade/pack.json', 'added'),
      ch('packs/django-upgrade/SKILL.md', 'added'),
      ch('packs/django-upgrade/references/4.2.md', 'added'),
      ch('eval/cases/django-new-messy/case.json', 'added'),
      ch('eval/cases/django-new-messy/truth.json', 'added'),
      ch('eval/runs/django-new-messy/v1/1/run.json', 'added'),
      ch('eval/runs/django-new-messy/baseline/1/run.json', 'added'),
      ch('eval/cases/django-ror-api-548/case.json', 'modified'), // completion, notes only
      ch('eval/cases/django-ror-api-548/truth.json', 'added'),
      ch('eval/runs/django-ror-api-548/v1/1/run.json', 'added'),
      ch('eval/seeded/django-tricky/ground_truth.json', 'added'),
      ch('eval/seeded/ratchet.json', 'modified'),
      ch('eval/seeded/recall.md', 'modified'),
      ch('eval/results.md', 'modified'),
      ch('eval/history/2026-10-24.json', 'added'),
      ch('eval/cases/coverage-gaps.json', 'modified'),
      ch('eval/cases/README.md', 'modified'), // added lines only
      ch('plugin/skills/django-upgrade/SKILL.md', 'added'),
      ch('docs/design.md', 'modified'),
      ch('test/unit/usages/django.test.ts', 'added'),
    ];
    const caseMeta = new Map<string, CaseMeta>([
      ['django-ror-api-548', djangoMeta],
      ['django-new-messy', { pack: 'django-upgrade', hadRuns: false, existedOnBase: false, existsAtHead: true }],
    ]);
    const input = base({
      changes,
      caseMeta,
      completions: new Map([['django-ror-api-548', { pinnedChanged: [], otherChanged: [] }]]),
      registryAdded: 1,
      registryRemoved: 0,
      newAdapterFiles: ['src/analysis/usages/django.ts'],
      coverageGaps: {
        base: ['nextjs-upgrade: a gap', 'django-upgrade: pending until the Django pack lands'],
        head: ['nextjs-upgrade: a gap', 'django-upgrade: settings covered'],
      },
    });
    expect(checkCoreUntouched(input)).toEqual(PASS);
  });
});

describe('exactly one owned pack', () => {
  it('two owned packs fails', () => {
    const p = checkCoreUntouched(base({ ownPacks: new Set(['django-upgrade', 'nextjs-upgrade']) }));
    expect(p.some((m) => m.includes('must own exactly one pack'))).toBe(true);
  });
});

describe('a file outside the allowlist, the registry line, and the one-adapter rule', () => {
  it('a core source file fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/pipeline/aggregate.ts')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('src/pipeline/aggregate.ts'))).toBe(true);
  });

  it('scoring code eval/seeded/recall.ts fails (round-1 H1)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/recall.ts')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('eval/seeded/recall.ts'))).toBe(true);
  });

  it('another pack under packs/ fails (round-1 H3)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('packs/nextjs-upgrade/pack.json')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('packs/nextjs-upgrade'))).toBe(true);
  });

  it('a foreign library under knowledge/ fails (round-1 H4)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('knowledge/npm/next/library.json')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('knowledge/npm/next'))).toBe(true);
  });

  it('another pack seeded repo fails (round-1 H6)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/next-tricky/ground_truth.json')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('next-tricky'))).toBe(true);
  });

  it('a second registry line fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch(REGISTRY_FILE)], registryAdded: 2, registryRemoved: 0 }));
    expect(p.some((m) => m.includes('pure addition of at most one line'))).toBe(true);
  });

  it('a one-line registry swap fails (a removed line is not a pure addition)', () => {
    const p = checkCoreUntouched(base({ changes: [ch(REGISTRY_FILE)], registryAdded: 1, registryRemoved: 1 }));
    expect(p.some((m) => m.includes('pure addition of at most one line') && m.includes('removed 1'))).toBe(true);
  });

  it('two new adapter files fail', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/analysis/usages/django.ts', 'added'), ch('src/analysis/usages/flask.ts', 'added')], newAdapterFiles: ['src/analysis/usages/django.ts', 'src/analysis/usages/flask.ts'] }));
    expect(p.some((m) => m.includes('more than one new usage adapter'))).toBe(true);
  });

  it('editing an existing adapter file fails (round-1 H2)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/analysis/usages/nextjs.ts', 'modified')] }));
    expect(p.some((m) => m.includes('existing usage adapter changed'))).toBe(true);
  });
});

describe('eval/history is add-only', () => {
  it('an edited file under eval/history fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/history/2026-01-01.json', 'modified')] }));
    expect(p.some((m) => m.includes('history files are add-only'))).toBe(true);
  });

  it('a deleted file under eval/history fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/history/2026-01-01.json', 'deleted')] }));
    expect(p.some((m) => m.includes('history files are add-only'))).toBe(true);
  });

  it('an added history file passes', () => {
    expect(checkCoreUntouched(base({ changes: [ch('eval/history/2026-12-31.json', 'added')] }))).toEqual(PASS);
  });
});

describe("another pack's cases and runs are off-limits", () => {
  it('a case added for another pack fails', () => {
    const caseMeta = new Map<string, CaseMeta>([['nextjs-new', { pack: 'nextjs-upgrade', hadRuns: false, existedOnBase: false, existsAtHead: true }]]);
    const p = checkCoreUntouched(base({ caseMeta, changes: [ch('eval/cases/nextjs-new/case.json', 'added')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade'))).toBe(true);
  });

  it('runs added for another pack fail', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/runs/nextjs-couchers-web-9893/v1/4/run.json', 'added')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade') && m.includes('run for case'))).toBe(true);
  });

  it('a case whose case.json cannot be read fails closed (round-1 H7)', () => {
    const caseMeta = new Map<string, CaseMeta>([['ghost-case', { pack: null, hadRuns: false, existedOnBase: false, existsAtHead: false }]]);
    const p = checkCoreUntouched(base({ caseMeta, changes: [ch('eval/runs/ghost-case/v1/1/run.json', 'added')] }));
    expect(p.some((m) => m.includes('no readable case.json'))).toBe(true);
  });
});

describe('a completion may change only notes and checks', () => {
  it('a changed pinned field fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/django-ror-api-548/case.json', 'modified')], completions: new Map([['django-ror-api-548', { pinnedChanged: ['target'], otherChanged: [] }]]) }));
    expect(p.some((m) => m.includes('changed pinned field(s) target'))).toBe(true);
  });

  it('a changed non-pinned field other than notes/checks fails (round-1 H8)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/django-ror-api-548/case.json', 'modified')], completions: new Map([['django-ror-api-548', { pinnedChanged: [], otherChanged: ['extra'] }]]) }));
    expect(p.some((m) => m.includes('outside notes/checks'))).toBe(true);
  });

  it('a notes/checks-only completion passes', () => {
    expect(checkCoreUntouched(base({ changes: [ch('eval/cases/django-ror-api-548/case.json', 'modified')], completions: new Map([['django-ror-api-548', { pinnedChanged: [], otherChanged: [] }]]) }))).toEqual(PASS);
  });
});

describe('a pack PR may never delete a case folder', () => {
  it("deleting its own pending case fails", () => {
    const meta = new Map<string, CaseMeta>([['django-ror-api-548', { ...djangoMeta, existsAtHead: false }]]);
    const p = checkCoreUntouched(base({ caseMeta: meta, casesRemoved: new Set(['django-ror-api-548']), changes: [ch('eval/cases/django-ror-api-548/case.json', 'deleted')] }));
    expect(p.some((m) => m.includes('may never remove a case') && m.includes("its own pack's"))).toBe(true);
  });

  it("deleting another pack's pending case fails", () => {
    const caseMeta = new Map<string, CaseMeta>([['nextjs-pending', { pack: 'nextjs-upgrade', hadRuns: false, existedOnBase: true, existsAtHead: false }]]);
    const p = checkCoreUntouched(base({ caseMeta, casesRemoved: new Set(['nextjs-pending']), changes: [ch('eval/cases/nextjs-pending/case.json', 'deleted')] }));
    expect(p.some((m) => m.includes('may never remove a case') && m.includes("another pack's"))).toBe(true);
  });

  it('deleting a non-case.json file from a pending case fails (round-1 noticed)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/django-ror-api-548/truth.json', 'deleted')] }));
    expect(p.some((m) => m.includes("a case folder's files are never deleted"))).toBe(true);
  });
});

describe('eval/cases/README.md is add-only', () => {
  it('editing or removing an existing line fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/README.md')], readmeExistingLineTouched: true }));
    expect(p.some((m) => m.includes('coverage matrix is add-only'))).toBe(true);
  });

  it('adding a line passes', () => {
    expect(checkCoreUntouched(base({ changes: [ch('eval/cases/README.md')], readmeExistingLineTouched: false }))).toEqual(PASS);
  });
});

describe('the seeded ratchet', () => {
  it('changing an existing ratchet entry fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/ratchet.json')], ratchetExistingEntryChanged: true }));
    expect(p.some((m) => m.includes('a floor on the base branch is frozen'))).toBe(true);
  });

  it('adding a new entry passes this check (the measured-recall rule is INV-50)', () => {
    expect(checkCoreUntouched(base({ changes: [ch('eval/seeded/ratchet.json')] }))).toEqual(PASS);
  });
});

describe('test/ is add-only', () => {
  it('editing a test file fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('test/permissions/deny-list.test.ts', 'modified')] }));
    expect(p.some((m) => m.includes('may only add test files') && m.includes('modified test/permissions/deny-list.test.ts'))).toBe(true);
  });

  it('deleting a test file fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('test/permissions/deny-list.test.ts', 'deleted')] }));
    expect(p.some((m) => m.includes('may only add test files') && m.includes('deleted test/permissions/deny-list.test.ts'))).toBe(true);
  });

  it('adding a test file passes', () => {
    expect(checkCoreUntouched(base({ changes: [ch('test/unit/usages/django.test.ts', 'added')] }))).toEqual(PASS);
  });
});

describe('eval/cases/coverage-gaps.json keeps every other pack entry', () => {
  const baseGaps = ['nextjs-upgrade: a gap', 'django-upgrade: pending until the Django pack lands'];

  it('removing this pack entry passes', () => {
    const p = checkCoreUntouched(base({
      changes: [ch('eval/cases/coverage-gaps.json')],
      coverageGaps: { base: baseGaps, head: ['nextjs-upgrade: a gap'] },
    }));
    expect(p).toEqual(PASS);
  });

  it('removing another pack entry fails', () => {
    const p = checkCoreUntouched(base({
      changes: [ch('eval/cases/coverage-gaps.json')],
      coverageGaps: { base: baseGaps, head: [] },
    }));
    expect(p.some((m) => m.includes('not owned by this pack') && m.includes('nextjs-upgrade: a gap'))).toBe(true);
  });

  it('a non-array fails closed', () => {
    const p = checkCoreUntouched(base({
      changes: [ch('eval/cases/coverage-gaps.json')],
      coverageGaps: { base: baseGaps, head: { gaps: [] } },
    }));
    expect(p.some((m) => m.includes('JSON array of strings'))).toBe(true);
  });
});

describe('the check does not import src/ or the recall scorer (round-2 must-fix A)', () => {
  function importSpecs(source: string): string[] {
    // Comments can name an example specifier (registry.ts's './<pack>.js').
    // They are not imports. A URL's :// is left intact.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    const specs: string[] = [];
    for (const match of code.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)) specs.push(match[1]!);
    for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(match[1]!);
    return specs;
  }

  function resolveRelative(fromFile: string, spec: string): string {
    const abs = path.resolve(path.dirname(fromFile), spec);
    const candidates = abs.endsWith('.js')
      ? [abs.slice(0, -3) + '.ts', abs.slice(0, -3) + '.tsx', abs]
      : [`${abs}.ts`, `${abs}.tsx`, path.join(abs, 'index.ts'), abs];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`cannot resolve ${spec} from ${fromFile}`);
  }

  function relativeImports(start: string): string[] {
    const seen = new Set<string>();
    const queue = [start];
    const found: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      found.push(path.relative(repoRoot, file).split(path.sep).join('/'));
      for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
      }
    }
    return found;
  }

  it('scripts/check-core-untouched.ts and scripts/lib/coreUntouched.ts reach neither src/ nor eval/seeded/recall.ts', () => {
    const files = [
      ...relativeImports(path.join(repoRoot, 'scripts/check-core-untouched.ts')),
      ...relativeImports(path.join(repoRoot, 'scripts/lib/coreUntouched.ts')),
    ];
    const bad = files.filter((file) => file === 'eval/seeded/recall.ts' || file.startsWith('src/'));
    expect(bad).toEqual([]);
  });
});
