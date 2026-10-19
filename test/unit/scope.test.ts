// Scope: size on the two fixtures, answers that only narrow, and the freeze.
import { cpSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usagesOutOfScope } from '../../src/core/proposeScope.js';
import { closeEngine, createEngine, findUsages, InputError, proposeScope, scanRepo, setScope, type Engine } from '../../src/core/index.js';
import { openSession } from '../../src/core/engine.js';
import { appendEvent } from '../../src/store/events.js';
import type { Usage } from '../../src/schema/usage.js';
import { copyFixture, repoRoot, tmpDir, writeTree } from '../helpers.js';

let engine: Engine;

beforeAll(() => {
  engine = createEngine({ out: tmpDir() });
});
afterAll(() => closeEngine(engine));

async function ready(repo: string, target = '16.0.0'): Promise<string> {
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: target } });
  expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  return id;
}

const usage = (over: Partial<Usage>): Usage =>
  ({
    id: 'u',
    repo_id: 'r',
    file: 'app/page.tsx',
    line_start: 1,
    line_end: 1,
    snippet_hash: 'h',
    kind: 'request_api',
    symbol: 'next/headers.cookies',
    module: 'next/headers',
    match_kind: 'call',
    context: '',
    via: [],
    confidence: 'exact',
    labels: [],
    ...over,
  }) as Usage;

describe('scope', () => {
  it('sizes next-clean as none and next-tricky as full, with the reasons', async () => {
    const clean = await ready(copyFixture('next-clean'));
    const none = await proposeScope(engine, { run_id: clean });
    expect(none.size).toBe('none');
    expect(none.reasons.join(' ')).toMatch(/complete|no usage/);
    expect(none.info).toEqual({ level: 0, checks_declared: false });

    const trickyRoot = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), trickyRoot, { recursive: true });
    const tricky = await ready(trickyRoot);
    const full = await proposeScope(engine, { run_id: tricky });
    expect(full.size).toBe('full');
    expect(full.reasons.some((r) => /unresolved|peer|high|codemod|match a composed rule|not complete/.test(r))).toBe(true);
    expect(full.questions.some((q) => q.id === 'depth')).toBe(false);
  });

  it('lets depth move toward full, rejects a lower depth, and reports defaults', async () => {
    const id = await ready(copyFixture('next-clean'));
    const proposed = await proposeScope(engine, { run_id: id });
    expect(proposed.size).toBe('none');
    expect(proposed.questions.map((q) => q.id)).toEqual(expect.arrayContaining(['stop_at', 'depth']));

    const up = await setScope(engine, { run_id: id, answers: { depth: 'full' } });
    expect(up.size).toBe('full');
    expect(up.defaults).toContain('stop_at');
    expect(up.answers['stop_at']).toBe('16');
    expect(up.defaults).not.toContain('depth');

    const fresh = await ready(copyFixture('next-clean'));
    await proposeScope(engine, { run_id: fresh });
    await expect(setScope(engine, { run_id: fresh, answers: { depth: 'small' } })).rejects.toMatchObject({ code: 'bad_answer' });
    const kept = await setScope(engine, { run_id: fresh, answers: {} });
    expect(kept.size).toBe('none');
    expect(kept.defaults).toEqual(expect.arrayContaining(['stop_at', 'depth']));
    expect(kept.answers['depth']).toBe('none');
  });

  it('rejects an option that was not offered, including a stop outside the supported range', async () => {
    const id = await ready(copyFixture('next-clean'));
    await proposeScope(engine, { run_id: id });
    await expect(setScope(engine, { run_id: id, answers: { stop_at: '99' } })).rejects.toMatchObject({ code: 'bad_answer' });
    await expect(setScope(engine, { run_id: id, answers: { include_deprecated: 'no' } })).rejects.toMatchObject({ code: 'bad_answer' });
  });

  it('freezes after a lens packet, and after merge_findings on a none run', async () => {
    const repo = copyFixture('next-clean');
    const packet = await ready(repo);
    await proposeScope(engine, { run_id: packet });
    appendEvent(openSession(engine, repo).db, { runId: packet, ts: '2026-10-19T00:00:00.000Z', step: 'test', kind: 'packet.fetched', payload: {} });
    await expect(setScope(engine, { run_id: packet, answers: {} })).rejects.toMatchObject({ code: 'scope_frozen' });

    const noneRepo = copyFixture('next-clean');
    const none = await ready(noneRepo);
    await proposeScope(engine, { run_id: none });
    expect((await proposeScope(engine, { run_id: none })).size).toBe('none');
    appendEvent(openSession(engine, noneRepo).db, { runId: none, ts: '2026-10-19T00:00:00.000Z', step: 'test', kind: 'merge.started', payload: {} });
    const err = await setScope(engine, { run_id: none, answers: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).message).toMatch(/frozen/);
  });

  it('drops usages outside the chosen packages, and records the reason', async () => {
    const repo = tmpDir();
    writeTree(repo, {
      'package.json': JSON.stringify({ name: 'ws', private: true, workspaces: ['apps/*'] }),
      'package-lock.json': JSON.stringify({
        name: 'ws',
        lockfileVersion: 3,
        packages: {
          '': { name: 'ws' },
          'apps/web': { name: 'web', dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' } },
          'apps/docs': { name: 'docs', dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' } },
          'node_modules/next': { version: '14.2.35' },
          'node_modules/react': { version: '18.3.1' },
          'node_modules/react-dom': { version: '18.3.1' },
        },
      }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' } }),
      'apps/docs/package.json': JSON.stringify({ name: 'docs', dependencies: { next: '^14.2.0', react: '^18.3.1', 'react-dom': '^18.3.1' } }),
      'apps/web/app/page.tsx': 'export default function Page() { return "web"; }\n',
      'apps/docs/app/page.tsx': 'export default function Page() { return "docs"; }\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' } }),
    });
    const id = await ready(repo);
    const proposed = await proposeScope(engine, { run_id: id });
    const targets = proposed.questions.find((q) => q.id === 'targets');
    expect(targets?.options.map((o) => o.id).sort()).toEqual(['apps/docs', 'apps/web']);
    await expect(setScope(engine, { run_id: id, answers: { targets: ['apps/other'] } })).rejects.toMatchObject({ code: 'bad_answer' });
    const set = await setScope(engine, { run_id: id, answers: { targets: ['apps/web'] } });
    expect(set.out_of_scope.length).toBeGreaterThan(0);
    expect(set.out_of_scope.every((e) => e.written_by === 'scope' && e.reason === 'scope: targets=apps/web')).toBe(true);
    expect(set.defaults).toEqual(expect.arrayContaining(['stop_at']));
  });

  it('builds out_of_scope reasons for a stop and for dropping deprecated usages', () => {
    const page = usage({ id: 'page', file: 'apps/docs/app/page.tsx' });
    const kept = usage({ id: 'kept', file: 'apps/web/app/page.tsx' });
    const dropped = usagesOutOfScope([page, kept], () => 'breaks', { targets: ['apps/web'], stopAt: '15', dropDeprecated: false }, () => true);
    expect(dropped).toEqual([{ usage_id: 'page', written_by: 'scope', reason: 'scope: targets=apps/web' }]);

    const stopped = usagesOutOfScope([page], () => 'breaks', { stopAt: '15', dropDeprecated: false }, (which) => which === 'full');
    expect(stopped).toEqual([{ usage_id: 'page', written_by: 'scope', reason: 'scope: stop_at=15' }]);

    const deprecated = usagesOutOfScope([page], () => 'deprecated', { dropDeprecated: true }, () => false);
    expect(deprecated).toEqual([{ usage_id: 'page', written_by: 'scope', reason: 'scope: include_deprecated=no' }]);
  });
});
