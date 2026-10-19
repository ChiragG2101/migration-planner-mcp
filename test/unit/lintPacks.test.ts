// One failing fixture per pack-lint rule. Each starts from a tree the lint
// accepts and breaks exactly one thing.
import { describe, expect, it } from 'vitest';
import { lintPacks, type VersionBase } from '../../scripts/lint-packs.js';
import { tmpDir, writeTree } from '../helpers.js';

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  event: 'removed',
  source: 'https://example.org/docs/15#cookies',
  status: 'reviewed',
  match: { kind: 'call', module: 'main', name: 'cookies' },
  concern: 'c',
  default_severity: 'high',
  mapping: { from: 'cookies()', to: 'await cookies()' },
  no_equivalent: false,
  notes: '',
  verify_hint: 'run npm test',
  rollback_hint: 'r',
  doc_topics: ['cookies'],
  ...over,
});

const library = (over: Record<string, unknown> = {}) => ({
  id: 'npm/main',
  ecosystem: 'npm',
  packages: ['main'],
  language: 'ts',
  version_scheme: 'semver',
  release_unit: 'major',
  covered_from: '14',
  doc_sources: ['https://example.org/docs/'],
  release_notes: { fetch: 'https://example.org/{version}.md', page: 'https://example.org/docs/{version}', format: 'md', sections: [{ heading: '*' }], skip: [] },
  codemods: [],
  ...over,
});

const pack = (over: Record<string, unknown> = {}) => ({
  name: 'main-upgrade',
  version: '0.1.0',
  kind: 'upgrade',
  language: 'ts',
  trigger: 'Use when upgrading main.',
  libraries: [{ id: 'npm/main', role: 'primary' }],
  supported: { from: '14', to: '15' },
  usage_adapter: 'nextjs',
  usage_kinds: [{ kind: 'dependency', lens: 'dependency_build' }],
  staging: 'leaf_first',
  checks_hint: 'your tests',
  references: [],
  seeded: 'demo',
  ...over,
});

function tree(over: Record<string, unknown> = {}): Record<string, string> {
  const files: Record<string, unknown> = {
    'knowledge/npm/main/library.json': library(),
    'knowledge/npm/main/CHANGELOG.md': '# changelog\n',
    'knowledge/npm/main/releases/13.json': {
      library: 'npm/main',
      release: '13',
      rules: [rule('main/old', { status: 'draft', source: 'https://example.org/docs/13#old', match: undefined })],
      events: [],
    },
    'knowledge/npm/main/releases/15.json': {
      library: 'npm/main',
      release: '15',
      rules: [rule('main/cookies')],
      events: [{ rule: 'main/old', event: 'removed' }],
    },
    'packs/main-upgrade/pack.json': pack(),
    'packs/main-upgrade/CHANGELOG.md': '# 0.1.0\n',
    'packs/main-upgrade/SKILL.md': '---\nname: main-upgrade\ndescription: Use when upgrading main.\n---\n\nSee [notes](references/notes.md).\n',
    'packs/main-upgrade/references/notes.md': '# notes\n',
    'eval/seeded/demo/ground_truth.json': {
      entries: [
        { rule_id: 'main/cookies', expect: 'change', indirect: false },
        { rule_id: 'main/cookies', expect: 'change', indirect: true },
      ],
    },
    ...over,
  };
  return Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
}

function lint(over: Record<string, unknown> = {}, base?: VersionBase): string[] {
  const root = tmpDir('mp-lint-');
  writeTree(root, tree(over));
  return lintPacks(root, base);
}

const release15 = (rules: unknown[], events: unknown[] = [{ rule: 'main/old', event: 'removed' }]) => ({
  'knowledge/npm/main/releases/15.json': { library: 'npm/main', release: '15', rules, events },
});

describe('pack lint', () => {
  it('accepts a sound tree, including a command that is only display text', () => {
    expect(lint()).toEqual([]);
  });

  it('rejects a file that is not JSON or Markdown', () => {
    expect(lint({ 'knowledge/npm/main/run.sh': 'echo hi' }).join('\n')).toMatch(/only \.json and \.md/);
  });

  it('rejects a broad trigger and one that does not name the library', () => {
    expect(lint({ 'packs/main-upgrade/pack.json': pack({ trigger: 'Use when upgrading main for any repo.' }) }).join('\n')).toMatch(/too broad/);
    expect(lint({ 'packs/main-upgrade/pack.json': pack({ trigger: 'Use when upgrading the framework.' }) }).join('\n')).toMatch(/must name the library/);
  });

  it('rejects a skill whose frontmatter is not first, or whose description is not the trigger', () => {
    const bannerFirst = '<!-- banner -->\n---\nname: main-upgrade\ndescription: Use when upgrading main.\n---\n';
    expect(lint({ 'packs/main-upgrade/SKILL.md': bannerFirst }).join('\n')).toMatch(/line 1/);
    const other = '---\nname: main-upgrade\ndescription: Use when migrating something else.\n---\n';
    expect(lint({ 'packs/main-upgrade/SKILL.md': other }).join('\n')).toMatch(/must equal the pack trigger/);
  });

  it('rejects a long SKILL.md and a reference link to a missing file', () => {
    expect(lint({ 'packs/main-upgrade/SKILL.md': Array.from({ length: 101 }, () => 'line').join('\n') }).join('\n')).toMatch(/101 lines/);
    expect(lint({ 'packs/main-upgrade/SKILL.md': 'See [x](references/missing.md).\n' }).join('\n')).toMatch(/references\/missing.md/);
  });

  it('rejects a codemod the registry does not know, and one the library does not list', () => {
    expect(lint(release15([rule('main/cookies', { codemod: 'nope:thing' })])).join('\n')).toMatch(/not in the core registry/);
    expect(lint(release15([rule('main/cookies', { codemod: 'next-codemod:upgrade' })])).join('\n')).toMatch(/not listed by npm\/main/);
  });

  it('rejects a shell command outside the display-text fields', () => {
    expect(lint(release15([rule('main/cookies', { notes: 'npm test' })])).join('\n')).toMatch(/shell command/);
  });

  it('rejects an unbumped pack version when its knowledge changed', () => {
    const base: VersionBase = { changed: ['knowledge/npm/main/releases/15.json'], versions: { 'main-upgrade': '0.1.0' } };
    expect(lint({}, base).join('\n')).toMatch(/was not bumped/);
    expect(lint({}, { changed: ['knowledge/npm/main/releases/15.json'], versions: { 'main-upgrade': '0.0.1' } })).toEqual([]);
  });

  it('rejects a missing changelog entry for the pack version', () => {
    expect(lint({ 'packs/main-upgrade/CHANGELOG.md': '# nothing\n' }).join('\n')).toMatch(/does not mention 0\.1\.0/);
  });

  it('rejects a duplicate rule id, an event for an unknown rule, and an event outside its release', () => {
    expect(lint({ 'knowledge/npm/main/releases/14.json': { library: 'npm/main', release: '14', rules: [rule('main/cookies', { source: 'https://example.org/docs/14#cookies' })], events: [] } }).join('\n')).toMatch(/also defined in/);
    expect(lint(release15([rule('main/cookies')], [{ rule: 'main/nope', event: 'removed' }])).join('\n')).toMatch(/unknown rule main\/nope/);
    expect(lint(release15([rule('main/cookies')], [{ rule: 'main/old', event: 'removed', version: '14.2' }])).join('\n')).toMatch(/not inside release 15/);
  });

  it('rejects a partial release file whose rule has no event at or after covered_from', () => {
    expect(lint(release15([rule('main/cookies')], [])).join('\n')).toMatch(/older than covered_from 14/);
  });

  it.each([
    ['a .. path', 'https://example.org/docs/../secret'],
    ['a look-alike host', 'https://example.org.evil/docs/x'],
    ['credentials', 'https://user:pass@example.org/docs/x'],
  ])('rejects a source with %s', (_label, source) => {
    expect(lint(release15([rule('main/cookies', { source })])).join('\n')).toMatch(/not under npm\/main's doc_sources/);
  });

  it('rejects an http source before the file can load', () => {
    expect(lint(release15([rule('main/cookies', { source: 'http://example.org/docs/x' })])).join('\n')).toMatch(/releases\/15\.json/);
  });

  it('rejects a sibling repo and a doc_sources prefix with no trailing slash', () => {
    const sibling = lint({
      'knowledge/npm/main/library.json': library({ doc_sources: ['https://github.com/vercel/next.js/'] }),
      ...release15([rule('main/cookies', { source: 'https://github.com/vercel/next.js-fork/blob/x' })]),
    });
    expect(sibling.join('\n')).toMatch(/not under npm\/main's doc_sources/);
    expect(lint({ 'knowledge/npm/main/library.json': library({ doc_sources: ['https://example.org/docs'] }) }).join('\n')).toMatch(/must end in \//);
  });

  it('rejects a reviewed rule whose match kind the adapter does not report', () => {
    expect(lint(release15([rule('main/cookies', { match: { kind: 'setting', name: 'USE_TZ' } })])).join('\n')).toMatch(/which nextjs does not report/);
  });

  it('rejects a reachable reviewed rule with no seeded case, and a call with no indirect case', () => {
    expect(lint({ 'eval/seeded/demo/ground_truth.json': { entries: [] } }).join('\n')).toMatch(/no expect: change seeded case/);
    expect(lint({ 'eval/seeded/demo/ground_truth.json': { entries: [{ rule_id: 'main/cookies', expect: 'change', indirect: false }] } }).join('\n')).toMatch(/no indirect seeded case/);
    expect(lint({ 'packs/main-upgrade/pack.json': pack({ seeded: 'missing' }) }).join('\n')).toMatch(/no ground_truth.json/);
  });

  it('rejects a supported range outside covered_from and the newest reviewed release', () => {
    expect(lint({ 'packs/main-upgrade/pack.json': pack({ supported: { from: '13', to: '15' } }) }).join('\n')).toMatch(/older than covered_from/);
    expect(lint({ 'packs/main-upgrade/pack.json': pack({ supported: { from: '14', to: '16' } }) }).join('\n')).toMatch(/past the newest reviewed release \(15\)/);
  });
});
