// INV-10 (C9): the knowledge schema rejects unknown keys and command-carrying
// fields, a reviewed rule must be complete, and `requires` belongs only on a
// peer_requirement rule. Drafts may be incomplete (they never load, INV-36).
import { describe, expect, it } from 'vitest';
import { Library, ReleaseFile, Rule } from '../../src/schema/knowledge.js';
import { Match } from '../../src/schema/match.js';

const reviewedRule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'next/async-request-apis',
  title: 'Request APIs are async',
  event: 'changed_behavior',
  source: 'https://nextjs.org/docs/app/guides/upgrading/version-15#async-request-apis-breaking-change',
  status: 'reviewed',
  match: { kind: 'call', module: 'next/headers', name: 'cookies' },
  concern: 'cookies() returns a promise',
  default_severity: 'high',
  mapping: { from: 'cookies().get(x)', to: '(await cookies()).get(x)' },
  no_equivalent: false,
  notes: '',
  verify_hint: 'Build the app and load a page that reads cookies.',
  rollback_hint: 'Revert the await and pin next to 14 again.',
  doc_topics: ['cookies async'],
  ...over,
});

const library = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'npm/next',
  ecosystem: 'npm',
  packages: ['next'],
  language: 'ts',
  version_scheme: 'semver',
  release_unit: 'major',
  covered_from: '14',
  doc_sources: ['https://nextjs.org/docs/'],
  release_notes: {
    fetch: 'https://raw.githubusercontent.com/vercel/next.js/canary/docs/version-{version}.mdx',
    page: 'https://nextjs.org/docs/app/guides/upgrading/version-{version}',
    format: 'mdx',
    sections: ['Breaking changes'],
  },
  codemods: [{ id: 'next-codemod:next-async-request-api', notes: 'Awaits the request APIs.' }],
  ...over,
});

const ok = (schema: { safeParse: (x: unknown) => { success: boolean } }, x: unknown): boolean => schema.safeParse(x).success;

describe('knowledge schema', () => {
  it('accepts a complete reviewed rule and a valid library', () => {
    expect(ok(Rule, reviewedRule())).toBe(true);
    expect(ok(Library, library())).toBe(true);
  });

  it('rejects unknown keys on a rule, a library, a release file and a match', () => {
    expect(ok(Rule, reviewedRule({ run: 'npx something' }))).toBe(false);
    expect(ok(Rule, { ...reviewedRule(), status: 'draft', script: 'x' })).toBe(false);
    expect(ok(Library, library({ postinstall: 'node x.js' }))).toBe(false);
    expect(ok(ReleaseFile, { library: 'npm/next', release: '15', rules: [], events: [], exec: 'x' })).toBe(false);
    expect(ok(Match, { kind: 'call', module: 'next/headers', name: 'cookies', command: 'x' })).toBe(false);
  });

  it('rejects a codemod entry with a command key', () => {
    expect(ok(Library, library({ codemods: [{ id: 'next-codemod:x', notes: 'n', command: 'npx @next/codemod x .' }] }))).toBe(false);
  });

  it('rejects a codemod reference that is not a registry ID', () => {
    expect(ok(Rule, reviewedRule({ codemod: 'npx @next/codemod next-async-request-api .' }))).toBe(false);
  });

  it('rejects a reviewed rule with an empty or missing match', () => {
    expect(ok(Rule, reviewedRule({ match: {} }))).toBe(false);
    const { match: _m, ...noMatch } = reviewedRule();
    expect(ok(Rule, noMatch)).toBe(false);
  });

  it('rejects a reviewed rule missing a required field', () => {
    for (const field of ['concern', 'default_severity', 'mapping', 'no_equivalent', 'verify_hint', 'rollback_hint', 'doc_topics', 'source']) {
      const r = reviewedRule();
      delete r[field];
      expect(ok(Rule, r), field).toBe(false);
    }
  });

  it('rejects a peer_requirement rule without requires, and requires on any other rule', () => {
    expect(ok(Rule, reviewedRule({ event: 'peer_requirement' }))).toBe(false);
    expect(ok(Rule, reviewedRule({ event: 'peer_requirement', requires: { library: 'npm/react', range: '>=19' } }))).toBe(true);
    for (const event of ['deprecated', 'removed', 'changed_behavior', 'changed_default', 'renamed']) {
      expect(ok(Rule, reviewedRule({ event, requires: { library: 'npm/react', range: '>=19' } })), event).toBe(false);
    }
  });

  it('accepts a draft with an empty match and empty fields', () => {
    const draft = { id: 'next/x', title: 'X', event: 'removed', source: 'https://nextjs.org/docs/x#y', status: 'draft' };
    expect(ok(Rule, draft)).toBe(true);
    expect(ok(Rule, { ...draft, concern: '', notes: '' })).toBe(true);
  });

  it('rejects a non-https source and a malformed rule ID', () => {
    expect(ok(Rule, reviewedRule({ source: 'http://nextjs.org/docs/x' }))).toBe(false);
    expect(ok(Rule, reviewedRule({ source: 'file:///etc/passwd' }))).toBe(false);
    expect(ok(Rule, reviewedRule({ id: 'async-request-apis' }))).toBe(false);
  });

  it('rejects a match glob that climbs out of the repo or is absolute', () => {
    expect(ok(Match, { kind: 'file_convention', glob: 'app/**/route.ts' })).toBe(true);
    expect(ok(Match, { kind: 'file_convention', glob: '../outside/**' })).toBe(false);
    expect(ok(Match, { kind: 'file_convention', glob: '/etc/**' })).toBe(false);
  });

  it('rejects a version that is not a plain release or version', () => {
    expect(ok(Library, library({ covered_from: '14.0.0-canary.1' }))).toBe(false);
    expect(ok(Rule, reviewedRule({ version: '15.0.0-rc.1' }))).toBe(false);
  });
});
