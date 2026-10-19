// Ingest: vague-input rejection, ambiguity questions, version resolution from
// lockfiles only, git state without running git, and idempotent run IDs.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepo, DEFAULT_LIMITS } from '../../src/analysis/scanner.js';
import { nextjsAdapter } from '../../src/analysis/usages/nextjs.js';
import { closeEngine, createEngine, ingest, InputError, NotBuiltError, type Engine } from '../../src/core/index.js';
import { decideVersions, idemKey, resolveRepo, ulid, type Decided } from '../../src/pipeline/ingest.js';
import { loadBundle, type Bundle } from '../../src/rules/loader.js';
import { PRE_RELEASE_MESSAGE } from '../../src/rules/versions.js';
import { openDb } from '../../src/store/db.js';
import { copyFixture, tmpDir, writeTree } from '../helpers.js';

const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);
let engine: Engine;
let out: string;
let next: string;

beforeAll(() => {
  out = tmpDir();
  let tick = Date.UTC(2026, 9, 19, 12, 0, 0);
  let seed = 0;
  engine = createEngine({
    out,
    now: () => new Date(tick++),
    randomBytes: (n) => Uint8Array.from({ length: n }, () => seed++ % 256),
  });
  next = copyFixture('next-basic');
});
afterAll(() => closeEngine(engine));

const req = (repo: string, source?: object, target?: object): Record<string, unknown> => ({
  repo_path: repo,
  ...(source ? { source } : {}),
  ...(target ? { target } : {}),
});

describe('vague input is rejected with a question', () => {
  it.each([
    ['no source', undefined, { name: 'next', version: '15.1.0' }, 'source.name'],
    ['no target', { name: 'next' }, undefined, 'target.name'],
    ['no target version', { name: 'next' }, { name: 'next' }, 'target.version'],
    ['unknown source', { name: 'modernise-everything' }, { name: 'next', version: '15' }, 'source.name'],
    ['unknown target', { name: 'next' }, { name: 'nuxt', version: '3' }, 'target.name'],
  ])('%s', async (_label, source, target, field) => {
    const res = await ingest(engine, req(next, source, target));
    expect(res).toMatchObject({ status: 'question', run: null, question: { kind: 'vague_input', field } });
  });

  it('a malformed input is an InputError, not a guess', async () => {
    await expect(ingest(engine, { repo_path: next, source: 'next' })).rejects.toThrow(InputError);
    await expect(ingest(engine, { repo_path: path.join(next, 'nope'), source: { name: 'next' } })).rejects.toThrow('does not exist');
  });
});

describe('version resolution', () => {
  it('resolves the installed version from the lockfile and accepts a matching prefix', async () => {
    const res = await ingest(engine, req(next, { name: 'next', version: '14.2' }, { name: 'next', version: '15.1.0' }));
    expect(res.status).toBe('ok');
    expect(res.versions).toEqual({ source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '15.1.0' } });
  });

  it('asks when the given source version disagrees with the lockfile', async () => {
    const res = await ingest(engine, req(next, { name: 'next', version: '13' }, { name: 'next', version: '15.1.0' }));
    expect(res.question).toMatchObject({ kind: 'version_mismatch', field: 'source.version' });
    expect(res.question!.candidates.map((c) => c.value)).toEqual(['14.2.35', '13']);
  });

  it('asks when no lockfile pins the source (never takes the agent\'s word)', async () => {
    const root = tmpDir();
    writeTree(root, { 'package.json': pkg({ dependencies: { next: '^14.0.0' } }) });
    const res = await ingest(engine, req(root, { name: 'next', version: '14.2.35' }, { name: 'next', version: '15' }));
    expect(res.question).toMatchObject({ kind: 'unresolved_version', field: 'source.version' });
  });

  it('asks with every candidate when workspace packages disagree', async () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': pkg({ workspaces: ['apps/*'] }),
      'apps/web/package.json': pkg({ dependencies: { next: '^14.2.0' } }),
      'apps/docs/package.json': pkg({ dependencies: { next: '^13.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/next': { version: '14.2.35' }, 'apps/docs/node_modules/next': { version: '13.5.6' } },
      }),
    });
    const res = await ingest(engine, req(root, { name: 'next' }, { name: 'next', version: '15.1.0' }));
    expect(res.question).toEqual({
      kind: 'ambiguous_version',
      field: 'source.version',
      message: expect.stringContaining('disagree') as unknown as string,
      candidates: [
        { value: '13.5.6', where: ['package-lock.json (package apps/docs)'] },
        { value: '14.2.35', where: ['package-lock.json (package apps/web)'] },
      ],
    });
  });

  it('asks when two lockfiles in one folder disagree', async () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': pkg({ dependencies: { next: '^14.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'yarn.lock': 'next@^14.0.0:\n  version "14.1.0"\n',
    });
    const res = await ingest(engine, req(root, { name: 'next' }, { name: 'next', version: '15.1.0' }));
    expect(res.question?.kind).toBe('ambiguous_version');
    expect(res.question!.candidates.map((c) => c.value)).toEqual(['14.1.0', '14.2.35']);
  });

  it('python names match case- and separator-insensitively, and requirements pins resolve', async () => {
    const repo = copyFixture('django-basic');
    const res = await ingest(engine, req(repo, { name: 'Django' }, { name: 'django', version: '4.2.30' }));
    expect(res.versions!.source).toEqual({ name: 'Django', version: '3.2.25' });
  });
});

describe('git state', () => {
  it('reads a branch HEAD from a loose ref, without running git; dirty is unknown', async () => {
    const repo = copyFixture('next-basic');
    const sha = 'a'.repeat(40);
    writeTree(repo, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${sha}\n`, '.git/index': 'binary' });
    const res = await ingest(engine, req(repo, { name: 'next' }, { name: 'next', version: '15.1.0' }));
    expect(res.git).toEqual({ is_repo: true, head_ref: 'refs/heads/main', head_commit: sha, dirty: 'unknown' });
  });

  it('reads packed-refs and a detached HEAD', async () => {
    const packed = copyFixture('next-basic');
    const sha = 'b'.repeat(40);
    writeTree(packed, { '.git/HEAD': 'ref: refs/heads/dev\n', '.git/packed-refs': `# pack-refs\n${sha} refs/heads/dev\n` });
    expect((await ingest(engine, req(packed, { name: 'next' }, { name: 'next', version: '15.1.0' }))).git!.head_commit).toBe(sha);
    const detached = copyFixture('next-basic');
    writeTree(detached, { '.git/HEAD': `${'c'.repeat(40)}\n` });
    expect((await ingest(engine, req(detached, { name: 'next' }, { name: 'next', version: '15.1.0' }))).git).toEqual({
      is_repo: true,
      head_ref: null,
      head_commit: 'c'.repeat(40),
      dirty: 'unknown',
    });
  });
});

describe('IDs', () => {
  it('re-ingesting the same key returns the same run; a new HEAD gives a new run', async () => {
    const repo = copyFixture('next-basic');
    writeTree(repo, { '.git/HEAD': `${'d'.repeat(40)}\n` });
    const input = req(repo, { name: 'next' }, { name: 'next', version: '15.1.0' });
    const first = await ingest(engine, input);
    const second = await ingest(engine, input);
    expect(second.run).toEqual(first.run);
    const other = await ingest(engine, req(repo, { name: 'next' }, { name: 'next', version: '15.2.0' }));
    expect(other.run!.run_id).not.toBe(first.run!.run_id);
    expect(other.run!.repo_id).toBe(first.run!.repo_id);
    writeTree(repo, { '.git/HEAD': `${'e'.repeat(40)}\n` });
    expect((await ingest(engine, input)).run!.run_id).not.toBe(first.run!.run_id);
  });

  it('files the run under the given campaign and records campaign and repo rows', async () => {
    const repo = copyFixture('next-basic');
    const res = await ingest(engine, { ...req(repo, { name: 'next' }, { name: 'next', version: '15.1.0' }), campaign_id: 'q4-upgrades' });
    expect(res.run!.campaign_id).toBe('q4-upgrades');
    const db = openDb(path.join(out, 'store.sqlite'));
    expect(db.prepare('SELECT id FROM campaigns WHERE id = ?').get('q4-upgrades')).toBeDefined();
    expect(db.prepare('SELECT root_realpath FROM repos WHERE id = ? AND campaign_id = ?').get(res.run!.repo_id, 'q4-upgrades')).toEqual({
      root_realpath: repo,
    });
    db.close();
  });

  it('records the pack ref and the companion versions, and the pack ref is part of the key', async () => {
    const repo = copyFixture('next-basic');
    const res = await ingest(engine, req(repo, { name: 'next' }, { name: 'next', version: '15.1.0' }));
    const db = openDb(path.join(out, 'store.sqlite'));
    const row = db.prepare('SELECT versions_json FROM runs WHERE id = ?').get(res.run!.run_id) as { versions_json: string };
    db.close();
    const rec = JSON.parse(row.versions_json) as Record<string, unknown>;
    expect(rec.pack).toBe(engine.bundle.packs.get('nextjs-upgrade')!.ref);
    expect(rec.pack).toMatch(/^nextjs-upgrade@0\.3\.0#[0-9a-f]{12}$/);
    expect(rec.companions).toEqual({ 'npm/react': '18.3.1' });
    expect(rec.ecosystem).toBe('node');
    const git = { is_repo: false, head_ref: null, head_commit: null, dirty: 'unknown' } as const;
    const v = { source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '15.1.0' } };
    expect(idemKey(repo, git, v, 'p@1#a')).not.toBe(idemKey(repo, git, v, 'p@1#b'));
  });

  it('records no pack for a library no pack covers', async () => {
    const res = await ingest(engine, req(copyFixture('django-basic'), { name: 'django' }, { name: 'django', version: '4.2.30' }));
    const db = openDb(path.join(out, 'store.sqlite'));
    const row = db.prepare('SELECT versions_json FROM runs WHERE id = ?').get(res.run!.run_id) as { versions_json: string };
    db.close();
    expect(JSON.parse(row.versions_json)).toMatchObject({ pack: null, companions: {}, ecosystem: 'python' });
  });

  it('ulid is 26 Crockford characters and sorts by time', () => {
    const a = ulid(1_700_000_000_000, new Uint8Array(10));
    const b = ulid(1_700_000_000_001, new Uint8Array(10).fill(255));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26));
  });
});

describe('pre-releases are refused at ingest, in the run\'s scheme (INV-38)', () => {
  it('refuses a pre-release target or given source for a pack library (semver)', async () => {
    const run = (s: object, t: object) => ingest(engine, req(next, s, t));
    await expect(run({ name: 'next' }, { name: 'next', version: '16.0.0-canary.1' })).rejects.toThrow(NotBuiltError);
    await expect(run({ name: 'next' }, { name: 'next', version: '16.0.0-canary.1' })).rejects.toThrow(PRE_RELEASE_MESSAGE);
    // Refused before the lockfile comparison, so it is not mistaken for a mismatch question.
    await expect(run({ name: 'next', version: '14.3.0-canary.2' }, { name: 'next', version: '15.1.0' })).rejects.toThrow(PRE_RELEASE_MESSAGE);
  });

  it('refuses a pre-release target for a library no pack covers, using the ecosystem\'s scheme (pep440)', async () => {
    const django = copyFixture('django-basic');
    for (const version of ['5.2a1', '==5.2a1', '5.2rc1', '5.2.dev3']) {
      await expect(ingest(engine, req(django, { name: 'django' }, { name: 'django', version }))).rejects.toThrow(PRE_RELEASE_MESSAGE);
    }
    expect((await ingest(engine, req(django, { name: 'django' }, { name: 'django', version: '5.2.post1' }))).status).toBe('ok');
  });

  it('refuses a pre-release installed in the lockfile, for the source and for a companion', async () => {
    const lock = (next: string, react: string) => ({
      'package.json': pkg({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: next }, 'node_modules/react': { version: react } } }),
    });
    const a = tmpDir();
    writeTree(a, lock('15.0.0-canary.5', '19.0.0'));
    await expect(ingest(engine, req(a, { name: 'next' }, { name: 'next', version: '16.0.0' }))).rejects.toThrow(`${PRE_RELEASE_MESSAGE} (installed next 15.0.0-canary.5)`);
    const b = tmpDir();
    writeTree(b, lock('15.0.3', '19.0.0-rc-66855b96-20241106'));
    await expect(ingest(engine, req(b, { name: 'next' }, { name: 'next', version: '16.0.0' }))).rejects.toThrow(`${PRE_RELEASE_MESSAGE} (installed react`);
  });

  it('a version that does not parse is bad input, not a refusal', async () => {
    await expect(ingest(engine, req(next, { name: 'next' }, { name: 'next', version: 'latest' }))).rejects.toThrow(InputError);
  });
});

describe('the pack\'s supported range bounds the target, by release unit', () => {
  // Fake packs checked up to 15 and 5.2, so the bundled pack's own range doesn't matter here.
  let bundle: Bundle;
  beforeAll(() => {
    const lib = (id: string, eco: string, scheme: string, unit: string, covered: string, packages: string[]) => ({
      id,
      ecosystem: eco,
      packages,
      language: eco === 'npm' ? 'ts' : 'python',
      version_scheme: scheme,
      release_unit: unit,
      covered_from: covered,
      doc_sources: ['https://example.org/docs/'],
      release_notes: { fetch: 'https://example.org/{version}.md', page: 'https://example.org/docs/{version}', format: 'md', sections: [{ heading: '*' }], skip: [] },
      codemods: [],
    });
    const pack = (name: string, primary: string, from: string, to: string, companions: string[]) => ({
      name,
      version: '0.1.0',
      kind: 'upgrade',
      language: 'ts',
      trigger: `Use when upgrading ${name}.`,
      libraries: [{ id: primary, role: 'primary' }, ...companions.map((id) => ({ id, role: 'companion' }))],
      supported: { from, to },
      usage_adapter: 'nextjs',
      usage_kinds: nextjsAdapter.usage_kinds.map((kind) => ({ kind, lens: 'api' })),
      staging: 'leaf_first',
      checks_hint: 'your tests',
      references: [],
      seeded: 'next-tricky',
    });
    const root = tmpDir('mp-fake-knowledge-');
    const files = {
      'knowledge/npm/next/library.json': lib('npm/next', 'npm', 'semver', 'major', '13', ['next']),
      'knowledge/npm/react/library.json': lib('npm/react', 'npm', 'semver', 'major', '18', ['react', 'react-dom']),
      'knowledge/pypi/django/library.json': lib('pypi/django', 'pypi', 'pep440', 'minor', '4.2', ['django']),
      'packs/next-fake/pack.json': pack('next-fake', 'npm/next', '14', '15', ['npm/react']),
      'packs/django-fake/pack.json': pack('django-fake', 'pypi/django', '4.2', '5.2', []),
    };
    writeTree(root, Object.fromEntries(Object.entries(files).map(([p, v]) => [p, JSON.stringify(v)])));
    bundle = loadBundle(root);
  });

  const decide = (fixture: string, name: string, version: string) => {
    const repo = copyFixture(fixture);
    const facts = analyzeRepo(repo, resolveRepo(repo).repoId, DEFAULT_LIMITS);
    return () => decideVersions({ repo_path: repo, source: { name }, target: { name, version } }, facts.packages, bundle);
  };

  it('refuses a target newer than supported.to and accepts patch releases inside it (semver, by major)', () => {
    expect(decide('next-basic', 'next', '16.0.0')).toThrow(NotBuiltError);
    expect(decide('next-basic', 'next', '16.0.0')).toThrow('target 16.0.0 is newer than this pack has been checked for (up to 15)');
    const ok = decide('next-basic', 'next', '15.3.2')() as Decided;
    expect(ok.pack?.pack.name).toBe('next-fake');
    expect(ok.companions).toEqual({ 'npm/react': '18.3.1' });
  });

  it('refuses a target newer than supported.to and accepts patch releases inside it (pep440, by X.Y)', () => {
    expect(decide('django-basic', 'django', '6.0')).toThrow('target 6.0 is newer than this pack has been checked for (up to 5.2)');
    expect(decide('django-basic', 'django', '==6.0')).toThrow(NotBuiltError);
    const ok = decide('django-basic', 'django', '5.2.7')() as Decided;
    expect(ok.pack?.pack.name).toBe('django-fake');
    expect(ok.versions.target.version).toBe('5.2.7');
  });

  it('the bundled Next.js pack refuses a target past 16', async () => {
    await expect(ingest(engine, req(next, { name: 'next' }, { name: 'next', version: '17.0.0' }))).rejects.toThrow(
      'target 17.0.0 is newer than this pack has been checked for (up to 16)',
    );
  });
});
