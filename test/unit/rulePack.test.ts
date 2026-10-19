// get_rule_pack on a real run, and the refusals for a library with no pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessRisk, closeEngine, createEngine, findUsages, getRulePack, listPackReferences, NotBuiltError, proposeScope, readPackReference, scanRepo, setScope, type Engine } from '../../src/core/index.js';
import { copyFixture, tmpDir } from '../helpers.js';

let engine: Engine;
let runId: string;

beforeAll(async () => {
  engine = createEngine({ out: tmpDir() });
  const scan = await scanRepo(engine, { repo_path: copyFixture('next-clean'), source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  expect(scan.status).toBe('ok');
  runId = scan.run!.run_id;
});
afterAll(() => closeEngine(engine));

describe('pack references', () => {
  it('serves only a bundled reference file, and a climbing path reads nothing', () => {
    const uri = 'pack://nextjs-upgrade/references/15.md';
    expect(listPackReferences().map((r) => r.uri)).toContain(uri);
    expect(readPackReference(uri)).toContain('# nextjs-upgrade 15');
    expect(readPackReference('pack://nextjs-upgrade/references/../pack.json')).toBeNull();
    expect(readPackReference('pack://nextjs-upgrade/references/../../package.json')).toBeNull();
    expect(readPackReference('https://nextjs-upgrade/references/15.md')).toBeNull();
    expect(readPackReference('pack://other/references/15.md')).toBeNull();
  });
});

describe('get_rule_pack', () => {
  it('returns the pack, its codemods and the reference paths for a run', async () => {
    const out = await getRulePack(engine, { run_id: runId });
    expect(out.pack).toMatch(/^nextjs-upgrade@0\.3\.0#/);
    expect(out.supported).toEqual({ from: '14', to: '16' });
    expect(out.references).toEqual([
      'pack://nextjs-upgrade/references/14.md',
      'pack://nextjs-upgrade/references/15.md',
      'pack://nextjs-upgrade/references/16.md',
      'pack://nextjs-upgrade/references/react-changes.md',
      'pack://nextjs-upgrade/references/codemods.md',
    ]);
    expect(out.codemods.map((c) => c.id)).toContain('next-codemod:next-async-request-api');
    const again = await getRulePack(engine, { source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '16.0.0' } });
    expect(again.pack).toBe(out.pack);
    expect(again.rules).toEqual(out.rules.filter((r) => r.library === 'npm/next'));
    // Without a run no lockfile gives React's installed version, so its changes are not composed, and the note says so.
    expect(out.rules.some((r) => r.library === 'npm/react')).toBe(true);
    expect(again.rules.some((r) => r.library === 'npm/react')).toBe(false);
    expect(again.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^no lockfile pins npm\/react/)]));
  });

  it('filters to rules that bind a usage only when a run is given', async () => {
    const out = await getRulePack(engine, { run_id: runId, present_only: true });
    expect(out.rules.length).toBeLessThanOrEqual((await getRulePack(engine, { run_id: runId })).rules.length);
    await expect(getRulePack(engine, { source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '16.0.0' }, present_only: true })).rejects.toMatchObject({
      code: 'present_only',
    });
  });

  it('refuses a library with no pack, from a run and from a source and target', async () => {
    const django = copyFixture('django-basic');
    const scan = await scanRepo(engine, { repo_path: django, source: { name: 'django' }, target: { name: 'django', version: '4.2.30' } });
    expect(scan.status).toBe('ok');
    const id = scan.run!.run_id;
    await findUsages(engine, { run_id: id });
    for (const call of [
      () => getRulePack(engine, { run_id: id }),
      () => assessRisk(engine, { run_id: id }),
      () => proposeScope(engine, { run_id: id }),
      () => setScope(engine, { run_id: id, answers: {} }),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotBuiltError);
      expect((err as Error).message).toBe('no pack for django in v0.1');
    }
    await expect(getRulePack(engine, { source: { name: 'django', version: '4.2' }, target: { name: 'django', version: '5.2' } })).rejects.toThrow(
      'no pack for django in v0.1',
    );
  });
});
