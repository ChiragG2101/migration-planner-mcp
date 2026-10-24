// "No core changes" allowlist unit tests (M10 Tests: No core changes). Feeds
// synthetic diffs to the pure core (scripts/lib/coreUntouched.ts), mirroring
// test/unit/eval/addOnly.test.ts. Every planted change in the plan's test list
// fails; a clean Django-shaped pack diff (including completing a pending M0
// case with only notes/checks changed) passes.
import { describe, expect, it } from 'vitest';
import { checkCoreUntouched, type CoreUntouchedInput, type CaseMeta, type PathChange } from '../../scripts/lib/coreUntouched.js';

const ch = (path: string, kind: PathChange['kind'] = 'modified'): PathChange => ({ path, kind });

// A pending Django case this PR completes, plus an existing Next.js case with runs.
const djangoMeta: CaseMeta = { pack: 'django-upgrade', hadRuns: false, existedOnBase: true };
const nextMeta: CaseMeta = { pack: 'nextjs-upgrade', hadRuns: true, existedOnBase: true };

const base = (over: Partial<CoreUntouchedInput>): CoreUntouchedInput => ({
  changes: [],
  ownPacks: new Set(['django-upgrade']),
  caseMeta: new Map<string, CaseMeta>([
    ['django-ror-api-548', djangoMeta],
    ['nextjs-couchers-web-9893', nextMeta],
  ]),
  casesRemoved: new Set(),
  completions: new Map(),
  readmeExistingLineTouched: false,
  ratchetBadNewEntries: [],
  ratchetOtherPackChanged: false,
  usagesIndexChangedLines: 0,
  ...over,
});

const PASS: readonly string[] = [];

describe('a clean Django-shaped pack diff passes', () => {
  it('adapter + registry line + knowledge + pack + new case + runs + seeded + docs + regenerated outputs', () => {
    const changes: PathChange[] = [
      ch('src/analysis/usages/django.ts', 'added'),
      ch('src/analysis/usages/index.ts', 'modified'), // one registry line (count checked separately)
      ch('knowledge/pypi/django/library.json', 'added'),
      ch('knowledge/pypi/django/releases/4.2.json', 'added'),
      ch('packs/django-upgrade/pack.json', 'added'),
      ch('packs/django-upgrade/SKILL.md', 'added'),
      ch('packs/django-upgrade/references/4.2.md', 'added'),
      // A brand-new Django case with its recorded runs.
      ch('eval/cases/django-new-messy/case.json', 'added'),
      ch('eval/cases/django-new-messy/truth.json', 'added'),
      ch('eval/runs/django-new-messy/v1/1/run.json', 'added'),
      ch('eval/runs/django-new-messy/baseline/1/run.json', 'added'),
      // Completing a pending M0 case: add truth, add runs, change case.json (notes/checks only).
      ch('eval/cases/django-ror-api-548/case.json', 'modified'),
      ch('eval/cases/django-ror-api-548/truth.json', 'added'),
      ch('eval/runs/django-ror-api-548/v1/1/run.json', 'added'),
      // Seeded repo, ratchet entry, regenerated recall.md, results.md, history, plugin, coverage, README, docs.
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
      ['django-new-messy', { pack: 'django-upgrade', hadRuns: false, existedOnBase: false }],
    ]);
    const input = base({
      changes,
      caseMeta,
      completions: new Map([['django-ror-api-548', { pinnedChanged: [] }]]),
      usagesIndexChangedLines: 1,
    });
    expect(checkCoreUntouched(input)).toEqual(PASS);
  });
});

describe('a file outside the allowlist, or a second registry line, fails', () => {
  it('a core source file outside the allowlist fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/pipeline/aggregate.ts')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('src/pipeline/aggregate.ts'))).toBe(true);
  });

  it('a scripts/ change (the lint it is checked by) fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('scripts/lint-packs.ts')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('scripts/lint-packs.ts'))).toBe(true);
  });

  it('the eval scoring code fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/runner.ts')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('eval/runner.ts'))).toBe(true);
  });

  it('a prompt change fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('prompts/plan_migration.v1.md')] }));
    expect(p.some((m) => m.includes('core file changed'))).toBe(true);
  });

  it('editing another pack under packs/ fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('packs/nextjs-upgrade/pack.json')] }));
    expect(p.some((m) => m.includes('core file changed') && m.includes('packs/nextjs-upgrade'))).toBe(true);
  });

  it('a second changed line in the usage registry fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/analysis/usages/index.ts')], usagesIndexChangedLines: 2 }));
    expect(p.some((m) => m.includes('exactly one registry line'))).toBe(true);
  });

  it('exactly one registry line passes', () => {
    const p = checkCoreUntouched(base({ changes: [ch('src/analysis/usages/index.ts')], usagesIndexChangedLines: 1 }));
    expect(p).toEqual(PASS);
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
    const p = checkCoreUntouched(base({ changes: [ch('eval/history/2026-12-31.json', 'added')] }));
    expect(p).toEqual(PASS);
  });
});

describe("another pack's cases and runs are off-limits to a pack PR", () => {
  it('a case folder added for another pack fails', () => {
    const caseMeta = new Map<string, CaseMeta>([['nextjs-new', { pack: 'nextjs-upgrade', hadRuns: false, existedOnBase: false }]]);
    const p = checkCoreUntouched(base({ caseMeta, changes: [ch('eval/cases/nextjs-new/case.json', 'added')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade') && m.includes("only its own pack's cases"))).toBe(true);
  });

  it('runs added for another pack fail', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/runs/nextjs-couchers-web-9893/v1/4/run.json', 'added')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade') && m.includes("records runs only for its own pack's cases"))).toBe(true);
  });

  it('completing another pack\'s case fails (its case.json edited)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/nextjs-couchers-web-9893/case.json', 'modified')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade'))).toBe(true);
  });

  it('editing a file in an existing case folder fails (another pack here)', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/nextjs-couchers-web-9893/truth.json', 'modified')] }));
    expect(p.some((m) => m.includes('belongs to pack nextjs-upgrade'))).toBe(true);
  });
});

describe('a completion may change only notes and checks', () => {
  it('a changed pinned field in a completed case fails', () => {
    const p = checkCoreUntouched(
      base({
        changes: [ch('eval/cases/django-ror-api-548/case.json', 'modified')],
        completions: new Map([['django-ror-api-548', { pinnedChanged: ['target'] }]]),
      }),
    );
    expect(p.some((m) => m.includes('changed pinned field(s) target'))).toBe(true);
  });

  it('a completion that moves only notes/checks passes', () => {
    const p = checkCoreUntouched(
      base({
        changes: [ch('eval/cases/django-ror-api-548/case.json', 'modified'), ch('eval/cases/django-ror-api-548/truth.json', 'added')],
        completions: new Map([['django-ror-api-548', { pinnedChanged: [] }]]),
      }),
    );
    expect(p).toEqual(PASS);
  });
});

describe('a pack PR may never delete a case folder', () => {
  it("deleting its own pack's pending case fails", () => {
    const p = checkCoreUntouched(
      base({
        casesRemoved: new Set(['django-ror-api-548']),
        changes: [ch('eval/cases/django-ror-api-548/case.json', 'deleted')],
      }),
    );
    expect(p.some((m) => m.includes('may never remove a case') && m.includes("its own pack's"))).toBe(true);
  });

  it("deleting another pack's pending case fails", () => {
    const caseMeta = new Map<string, CaseMeta>([['nextjs-pending', { pack: 'nextjs-upgrade', hadRuns: false, existedOnBase: true }]]);
    const p = checkCoreUntouched(
      base({ caseMeta, casesRemoved: new Set(['nextjs-pending']), changes: [ch('eval/cases/nextjs-pending/case.json', 'deleted')] }),
    );
    expect(p.some((m) => m.includes('may never remove a case') && m.includes("another pack's"))).toBe(true);
  });
});

describe('eval/cases/README.md is add-only (one line per new case)', () => {
  it('editing or removing an existing README line fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/README.md', 'modified')], readmeExistingLineTouched: true }));
    expect(p.some((m) => m.includes('coverage matrix is add-only'))).toBe(true);
  });

  it('adding a README line passes', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/cases/README.md', 'modified')], readmeExistingLineTouched: false }));
    expect(p).toEqual(PASS);
  });
});

describe('the seeded ratchet', () => {
  it('a new entry that does not equal the measured recall fails', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/ratchet.json')], ratchetBadNewEntries: ['new entry django-tricky is 0.9, but the measured recall is 0.7500'] }));
    expect(p.some((m) => m.includes('django-tricky') && m.includes('measured recall is'))).toBe(true);
  });

  it("changing another pack's ratchet entry fails", () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/ratchet.json')], ratchetOtherPackChanged: true }));
    expect(p.some((m) => m.includes("another pack's floor is frozen"))).toBe(true);
  });

  it('a new entry equal to its measured recall passes', () => {
    const p = checkCoreUntouched(base({ changes: [ch('eval/seeded/ratchet.json')] }));
    expect(p).toEqual(PASS);
  });
});
