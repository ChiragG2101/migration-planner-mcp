// Ingest: vague-input rejection, ambiguity questions, version resolution from
// lockfiles only, git state without running git, and idempotent run IDs.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, ingest, InputError, type Engine } from '../../src/core/index.js';
import { ulid } from '../../src/pipeline/ingest.js';
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

  it('ulid is 26 Crockford characters and sorts by time', () => {
    const a = ulid(1_700_000_000_000, new Uint8Array(10));
    const b = ulid(1_700_000_000_001, new Uint8Array(10).fill(255));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26));
  });
});
