// The release-notes parser, on recorded notes. An unknown heading is reported
// and never turned into an item.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftFromNotes } from '../../scripts/lib/draft.js';
import { buildReport } from '../../scripts/lib/report.js';
import { parseReleaseNotes, slugAnchor, type NotesConfig } from '../../scripts/lib/release-notes.js';
import type { LoadedLibrary } from '../../src/rules/compose.js';
import type { Library, ReleaseFile } from '../../src/schema/knowledge.js';
import type { Pack } from '../../src/schema/pack.js';
import { fixturesDir } from '../helpers.js';

const notes = (name: string): string => readFileSync(path.join(fixturesDir, 'release-notes', name), 'utf8');

const next: NotesConfig = {
  format: 'mdx',
  sections: [{ heading: '*' }, { heading: 'Removals', event: 'removed' }],
  skip: ['Upgrading from 14 to 15', 'Use a coding agent', 'Troubleshooting'],
};

const react: NotesConfig = {
  format: 'md',
  sections: [
    { heading: 'Breaking changes' },
    { heading: 'Removed deprecated React APIs', event: 'removed' },
    { heading: 'New deprecations', event: 'deprecated' },
  ],
  skip: ['Installing', 'Changelog'],
};

const django: NotesConfig = {
  format: 'rst',
  sections: [{ heading: 'Breaking changes' }, { heading: 'Other changes', event: 'changed' }],
  skip: ['Upgrading'],
};

describe('parseReleaseNotes', () => {
  it('reads mdx: top-level headings are items, a named section yields its children, fences are not headings', () => {
    const parsed = parseReleaseNotes(notes('next.mdx'), next);
    expect(parsed.items).toEqual([
      { title: 'Async Request APIs', anchor: 'async-request-apis', section: '*' },
      { title: 'AMP Support', anchor: 'amp-support', section: 'Removals', event: 'removed' },
      { title: 'next lint Command', anchor: 'next-lint-command', section: 'Removals', event: 'removed' },
      { title: 'Mystery section', anchor: 'mystery-section', section: '*' },
    ]);
    expect(parsed.unknown).toEqual([]);
  });

  it('reads md: nested headings, explicit {/*id*/} anchors, and a section event', () => {
    const parsed = parseReleaseNotes(notes('react.md'), react);
    expect(parsed.items.map((i) => [i.title, i.anchor, i.event ?? null])).toEqual([
      ['ref is a regular prop', 'ref-as-a-prop', null],
      ['React.createFactory', 'removed-createfactory', 'removed'],
      ['react-dom: ReactDOM.render', 'removed-reactdom-render', 'removed'],
      ['element.ref', 'deprecated-element-ref', 'deprecated'],
    ]);
    expect(parsed.unknown).toEqual(['Not in the config']);
  });

  it('reads rst: underline headings, explicit anchors, bullets when a section has no child headings', () => {
    const parsed = parseReleaseNotes(notes('django.rst'), django);
    expect(parsed.items.map((i) => [i.title, i.anchor, i.section])).toEqual([
      ['request.user is lazy', 'request-user-is-lazy', 'Breaking changes'],
      ['ugettext removed', 'removed-ugettext', 'Breaking changes'],
      ['The default USE_L10N is True.', 'the-default-use-l10n-is-true', 'Other changes'],
      ['django.utils.timezone grows a helper.', 'django-utils-timezone-grows-a-helper', 'Other changes'],
    ]);
    expect(parsed.unknown).toEqual(['Unlisted section']);
  });

  it('visits a configured section nested inside another, and does not report its children as unknown', () => {
    const text = ['## Breaking changes', '', '### Removed deprecated React APIs', '', '#### Removed: string refs {/*removed-string-refs*/}', '', 'Gone.', ''].join('\n');
    const parsed = parseReleaseNotes(text, react);
    expect(parsed.items).toEqual([{ title: 'Removed: string refs', anchor: 'removed-string-refs', section: 'Removed deprecated React APIs', event: 'removed' }]);
    expect(parsed.unknown).toEqual([]);
  });

  it('slugs a heading the same way with or without markup', () => {
    expect(slugAnchor('`next lint` Command')).toBe('next-lint-command');
    expect(slugAnchor('Async Request APIs')).toBe('async-request-apis');
  });
});

const exampleLibrary = (): Library => ({
  id: 'npm/example',
  ecosystem: 'npm',
  packages: ['example'],
  language: 'ts',
  version_scheme: 'semver',
  release_unit: 'major',
  covered_from: '14',
  doc_sources: ['https://example.org/docs/'],
  release_notes: {
    fetch: 'https://example.org/{version}.md',
    page: 'https://example.org/docs/{version}',
    format: 'md',
    sections: [{ heading: '*' }],
    skip: [],
  },
  codemods: [],
});

describe('drafter', () => {
  const notes = '## Async cookies\n\nNow async.\n\n## Removed flag\n';

  it('writes a draft per item and never overwrites a reviewed rule or an existing draft', () => {
    const library = exampleLibrary();
    const existing: ReleaseFile = {
      library: 'npm/example',
      release: '15',
      rules: [
        {
          id: 'example/async-cookies',
          title: 'Async cookies',
          event: 'changed_behavior',
          source: 'https://example.org/docs/15#async-cookies',
          status: 'reviewed',
          match: { kind: 'call', module: 'example', name: 'cookies' },
          concern: 'c',
          default_severity: 'high',
          mapping: { from: 'cookies()', to: 'await cookies()' },
          no_equivalent: false,
          notes: '',
          verify_hint: 'v',
          rollback_hint: 'r',
          doc_topics: ['cookies'],
        },
      ],
      events: [],
    };
    const first = draftFromNotes(library, '15', notes, 'https://example.org/docs/15', existing);
    expect(first.added).toEqual(['example/removed-flag']);
    expect(first.kept).toEqual(['example/async-cookies']);
    expect(first.file.rules[0]).toEqual(existing.rules[0]);
    expect(first.file.rules[1]).toMatchObject({ id: 'example/removed-flag', status: 'draft', event: 'changed_behavior' });
    const again = draftFromNotes(library, '15', notes, 'https://example.org/docs/15', first.file);
    expect(again.added).toEqual([]);
    expect(again.file.rules.map((r) => r.id)).toEqual(['example/async-cookies', 'example/removed-flag']);
  });
});

describe('pack update report', () => {
  it('lists a missing item, a dead source, a draft and an unseeded reviewed rule', () => {
    const library = exampleLibrary();
    const lib: LoadedLibrary = { library, releases: [{ release: '15', rules: [], events: [] }] };
    const pack: Pack = {
      name: 'example-upgrade',
      version: '0.1.0',
      kind: 'upgrade',
      language: 'ts',
      trigger: 'Use when upgrading example.',
      libraries: [{ id: 'npm/example', role: 'primary' }],
      supported: { from: '14', to: '16' },
      usage_adapter: 'nextjs',
      usage_kinds: [{ kind: 'dependency', lens: 'dependency_build' }],
      staging: 'leaf_first',
      checks_hint: 'your tests',
      references: [],
      seeded: 'next-tricky',
    };
    const file: ReleaseFile = {
      library: 'npm/example',
      release: '15',
      rules: [
        {
          id: 'example/kept',
          title: 'Kept',
          event: 'removed',
          source: 'https://example.org/docs/15#kept',
          status: 'reviewed',
          match: { kind: 'call', module: 'example', name: 'kept' },
          concern: 'c',
          default_severity: 'medium',
          mapping: { from: 'a', to: 'b' },
          no_equivalent: false,
          notes: '',
          verify_hint: 'v',
          rollback_hint: 'r',
          doc_topics: ['t'],
        },
        {
          id: 'example/dead',
          title: 'Dead',
          event: 'removed',
          source: 'https://example.org/docs/15#gone',
          status: 'reviewed',
          match: { kind: 'call', module: 'example', name: 'dead' },
          concern: 'c',
          default_severity: 'medium',
          mapping: { from: 'a', to: 'b' },
          no_equivalent: false,
          notes: '',
          verify_hint: 'v',
          rollback_hint: 'r',
          doc_topics: ['t'],
        },
        { id: 'example/drafted', title: 'Drafted', event: 'deprecated', source: 'https://example.org/docs/15#drafted', status: 'draft' },
      ],
      events: [],
    };
    const report = buildReport(pack, new Map([['npm/example', lib]]), new Map([['npm/example@15', '## Kept\n\n## Drafted\n\n## Missing item\n']]), [file], [
      { rule_id: 'example/kept', expect: 'change' },
    ]);
    expect(report.missing.map((m) => m.title)).toEqual(['Missing item']);
    expect(report.stale.map((s) => s.id)).toEqual(['example/dead']);
    expect(report.drafts.map((d) => d.id)).toEqual(['example/drafted']);
    expect(report.unseeded.map((u) => u.id)).toEqual(['example/dead']);
  });
});
