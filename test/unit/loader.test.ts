// INV-36 and the loader's fail-closed checks. Each case builds a small valid
// data tree in a temp dir, breaks one thing and expects the load to stop with
// a message naming the file. Drafts are skipped and counted, not loaded.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextjsAdapter } from '../../src/analysis/usages/nextjs.js';
import { loadBundle, loadBundled, packForLibrary } from '../../src/rules/loader.js';
import { THIRD_PARTY_MESSAGE } from '../../src/security/dataFiles.js';
import { InputError, NotBuiltError, PermissionError } from '../../src/security/errors.js';
import { copyFixture, repoRoot, runCli, symlink, tmpDir, writeTree } from '../helpers.js';

type Tree = Record<string, unknown>;

const library = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ecosystem: 'npm',
  packages: [id.split('/')[1]],
  language: 'ts',
  version_scheme: 'semver',
  release_unit: 'major',
  covered_from: '2',
  doc_sources: ['https://example.org/docs/'],
  release_notes: { fetch: 'https://example.org/{version}.md', page: 'https://example.org/docs/{version}', format: 'md', sections: [{ heading: '*' }], skip: [] },
  codemods: [],
  ...over,
});

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  event: 'removed',
  source: 'https://example.org/docs/2',
  status: 'reviewed',
  match: { kind: 'call', module: 'main', name: 'f' },
  concern: 'c',
  default_severity: 'medium',
  mapping: { from: 'a', to: 'b' },
  no_equivalent: false,
  notes: '',
  verify_hint: 'v',
  rollback_hint: 'r',
  doc_topics: ['t'],
  ...over,
});

const pack = (over: Record<string, unknown> = {}) => ({
  name: 'main-upgrade',
  version: '0.1.0',
  kind: 'upgrade',
  language: 'ts',
  trigger: 'Use when upgrading main.',
  libraries: [
    { id: 'npm/main', role: 'primary' },
    { id: 'npm/peer', role: 'companion' },
  ],
  supported: { from: '2', to: '3' },
  usage_adapter: 'nextjs',
  usage_kinds: nextjsAdapter.usage_kinds.map((kind) => ({ kind, lens: 'api' })),
  staging: 'leaf_first',
  checks_hint: 'your tests',
  references: [],
  seeded: 'next-tricky',
  ...over,
});

function base(): Tree {
  return {
    'knowledge/npm/main/library.json': library('npm/main'),
    'knowledge/npm/main/CHANGELOG.md': '# changelog\n',
    'knowledge/npm/main/releases/2.json': {
      library: 'npm/main',
      release: '2',
      rules: [rule('main/a'), rule('main/draft', { status: 'draft' }), rule('main/peer', { event: 'peer_requirement', requires: { library: 'npm/peer', range: '^5.0.0' } })],
      events: [],
    },
    'knowledge/npm/main/releases/3/api.json': { library: 'npm/main', release: '3', area: 'api', rules: [rule('main/b', { version: '3.1' })], events: [{ rule: 'main/a', event: 'deprecated' }] },
    'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('main/c')], events: [{ rule: 'main/draft', event: 'removed' }] },
    'knowledge/npm/peer/library.json': library('npm/peer'),
    'packs/main-upgrade/pack.json': pack(),
    'packs/main-upgrade/CHANGELOG.md': '# changelog\n',
  };
}

function write(tree: Tree): string {
  const root = tmpDir('mp-loader-');
  writeTree(root, Object.fromEntries(Object.entries(tree).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)])));
  return root;
}

function refused(tree: Tree, file: string, message: RegExp): void {
  let caught: unknown;
  try {
    loadBundle(write(tree));
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the load to be refused').toBeInstanceOf(InputError);
  expect((caught as InputError).message).toContain(file);
  expect((caught as InputError).message).toMatch(message);
}

describe('loader: a valid tree', () => {
  it('loads reviewed rules, merges area files, and skips and counts drafts', () => {
    const b = loadBundle(write(base()));
    const main = b.libraries.get('npm/main')!;
    expect(main.releases.map((r) => r.release)).toEqual(['2', '3']);
    expect(main.releases[0]!.rules.map((r) => r.id)).toEqual(['main/a', 'main/peer']);
    expect(main.releases[1]!.rules.map((r) => r.id).sort()).toEqual(['main/b', 'main/c']);
    // The draft's later event is dropped with the draft.
    expect(main.releases[1]!.events).toEqual([{ rule: 'main/a', event: 'deprecated' }]);
    expect(b.drafts.get('npm/main')).toBe(1);
    const p = b.packs.get('main-upgrade')!;
    expect(p.rules).toBe(4);
    expect(p.drafts).toBe(1);
    expect(p.ref).toMatch(/^main-upgrade@0\.1\.0#[0-9a-f]{12}$/);
    expect(packForLibrary(b, 'main', 'node')?.pack.name).toBe('main-upgrade');
    expect(packForLibrary(b, 'main', 'python')).toBeUndefined();
    expect(packForLibrary(b, 'peer', 'node')).toBeUndefined();
  });

  it('changes the pack hash when a knowledge file of its libraries changes, and only then', () => {
    const t = base();
    const h0 = loadBundle(write(t)).packs.get('main-upgrade')!.hash;
    expect(loadBundle(write({ ...t, 'packs/main-upgrade/CHANGELOG.md': '# other\n' })).packs.get('main-upgrade')!.hash).toBe(h0);
    const changed = { ...t, 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('main/c', { notes: 'x' })], events: [] } };
    expect(loadBundle(write(changed)).packs.get('main-upgrade')!.hash).not.toBe(h0);
    expect(loadBundle(write({ ...t, 'knowledge/npm/peer/library.json': library('npm/peer', { covered_from: '3' }) })).packs.get('main-upgrade')!.hash).not.toBe(h0);
  });

  it('loads the bundled data, with the Next.js pack and its usage adapter', () => {
    const b = loadBundled();
    const p = b.packs.get('nextjs-upgrade')!;
    expect(p.pack.usage_adapter).toBe('nextjs');
    expect([...p.libs.keys()]).toEqual(['npm/next', 'npm/react']);
    expect(packForLibrary(b, 'next', 'node')?.pack.name).toBe('nextjs-upgrade');
  });
});

describe('loader: refusals', () => {
  it('refuses a file that is not JSON or Markdown, and a symlink', () => {
    expect(() => loadBundle(write({ ...base(), 'knowledge/npm/main/run.sh': 'echo hi' }))).toThrow(/only \.json and \.md/);
    const root = write(base());
    symlink(path.join(root, 'knowledge/npm/peer/library.json'), path.join(root, 'knowledge/npm/main/linked.json'));
    expect(() => loadBundle(root)).toThrow(PermissionError);
  });

  it('refuses bad JSON and a schema failure', () => {
    refused({ ...base(), 'knowledge/npm/peer/library.json': '{' }, 'knowledge/npm/peer/library.json', /not valid JSON/);
    refused({ ...base(), 'knowledge/npm/peer/library.json': library('npm/peer', { command: 'rm' }) }, 'knowledge/npm/peer/library.json', /command/);
  });

  it('refuses ids and names that do not match their folder', () => {
    refused({ ...base(), 'knowledge/npm/peer/library.json': library('npm/other') }, 'knowledge/npm/peer/library.json', /does not match its folder/);
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ name: 'other' }) }, 'packs/main-upgrade/pack.json', /does not match its folder/);
    const t = base();
    refused({ ...t, 'knowledge/npm/main/releases/2.json': { ...(t['knowledge/npm/main/releases/2.json'] as object), release: '4' } }, 'releases/2.json', /does not match its file name/);
    refused({ ...t, 'knowledge/npm/main/releases/2.json': { ...(t['knowledge/npm/main/releases/2.json'] as object), library: 'npm/peer' } }, 'releases/2.json', /does not match its folder/);
    refused({ ...t, 'knowledge/npm/main/releases/3/api.json': { library: 'npm/main', release: '3', rules: [], events: [] } }, 'releases/3/api.json', /needs "area": "api"/);
  });

  it('refuses knowledge without a library.json and files in the wrong place', () => {
    refused({ ...base(), 'knowledge/npm/ghost/releases/2.json': { library: 'npm/ghost', release: '2', rules: [], events: [] } }, 'knowledge/npm/ghost', /no library\.json/);
    refused({ ...base(), 'knowledge/npm/main/rules.json': {} }, 'knowledge/npm/main/rules.json', /not a library\.json/);
  });

  it('refuses versions that do not parse in the scheme, including pre-releases', () => {
    refused({ ...base(), 'knowledge/npm/main/library.json': library('npm/main', { covered_from: '2.0.0-rc.1' }) }, 'library.json', /plain version[\s\S]*covered_from/);
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('main/c', { replacement_since: '3.0.0-beta.1' })], events: [] } }, 'releases/3/config.json', /plain version[\s\S]*replacement_since/);
  });

  it('refuses a version outside its file\'s release', () => {
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('main/c', { version: '4.1' })], events: [] } }, 'releases/3/config.json', /not inside release 3/);
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [], events: [{ rule: 'main/a', event: 'removed', version: '2.5' }] } }, 'releases/3/config.json', /not inside release 3/);
  });

  it('refuses duplicate rule ids and ids without the library prefix', () => {
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('main/a')], events: [] } }, 'releases/3/config.json', /also defined in/);
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [rule('peer/x')], events: [] } }, 'releases/3/config.json', /must start with main\//);
  });

  it('refuses events for unknown rules and events not in a later release', () => {
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [], events: [{ rule: 'main/zz', event: 'removed' }] } }, 'releases/3/config.json', /unknown rule main\/zz/);
    refused({ ...base(), 'knowledge/npm/main/releases/3/config.json': { library: 'npm/main', release: '3', area: 'config', rules: [], events: [{ rule: 'main/b', event: 'removed' }] } }, 'releases/3/config.json', /later release than 3/);
  });

  it('refuses a requirement on an unknown library or with an invalid range', () => {
    const t = base();
    const r2 = (requires: object) => ({ library: 'npm/main', release: '2', rules: [rule('main/a'), rule('main/draft', { status: 'draft' }), rule('main/peer', { event: 'peer_requirement', requires })], events: [] });
    refused({ ...t, 'knowledge/npm/main/releases/2.json': r2({ library: 'npm/nope', range: '^5.0.0' }) }, 'releases/2', /unknown library npm\/nope/);
    refused({ ...t, 'knowledge/npm/main/releases/2.json': r2({ library: 'npm/peer', range: 'not a range' }) }, 'releases/2', /invalid range/);
  });

  it('refuses a pack naming a library with no knowledge, or a supported version that does not parse', () => {
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ libraries: [{ id: 'npm/main', role: 'primary' }, { id: 'npm/nope', role: 'companion' }] }) }, 'pack.json', /npm\/nope has no knowledge/);
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ supported: { from: '2', to: 'three' } }) }, 'pack.json', /plain version[\s\S]*supported\.to/);
  });

  it('refuses an unknown usage adapter, and a lens map that misses or invents a usage kind', () => {
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ usage_adapter: 'nope' }) }, 'pack.json', /usage_adapter nope is not a registered/);
    const kinds = nextjsAdapter.usage_kinds.map((kind) => ({ kind, lens: 'api' }));
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ usage_kinds: kinds.filter((k) => k.kind !== 'fetch_call') }) }, 'pack.json', /no lens for fetch_call/);
    refused({ ...base(), 'packs/main-upgrade/pack.json': pack({ usage_kinds: [...kinds, { kind: 'made_up', lens: 'api' }] }) }, 'pack.json', /names made_up, which nextjs never reports/);
  });
});

describe('loader: --rules-dir', () => {
  it('accepts the bundled data and refuses any other folder as not built', () => {
    expect(() => loadBundled(repoRoot)).not.toThrow();
    expect(() => loadBundled(path.join(repoRoot, 'knowledge'))).not.toThrow();
    const other = write(base());
    expect(() => loadBundled(other)).toThrow(NotBuiltError);
    expect(() => loadBundled(other)).toThrow(THIRD_PARTY_MESSAGE);
    expect(() => loadBundled(path.join(other, 'missing'))).toThrow(THIRD_PARTY_MESSAGE);
  });

  it('the CLI refuses another --rules-dir (exit 2) and logs the loaded pack to stderr only', () => {
    const repo = copyFixture('next-basic');
    const refusedRun = runCli(['scan', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', tmpDir(), '--rules-dir', write(base())]);
    expect(refusedRun.status).toBe(2);
    expect(refusedRun.stderr).toContain(`refused: ${THIRD_PARTY_MESSAGE}`);
    const ok = runCli(['scan', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', tmpDir(), '--rules-dir', repoRoot]);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toMatch(/pack nextjs-upgrade@0\.3\.0#[0-9a-f]{12}: \d+ reviewed rules, \d+ draft rules skipped/);
    expect(ok.stdout).not.toContain('nextjs-upgrade@');
  });
});
