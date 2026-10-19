// find_usages through the core API: pagination that never truncates
// silently, filters, the sha256 facts cache, the timing event, the stored
// import graph and symbols, and a count showing nothing is dropped silently.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, findUsages, InputError, scanRepo, type Engine } from '../../../src/core/index.js';
import { openSession } from '../../../src/core/engine.js';
import { listEvents } from '../../../src/store/events.js';
import { listImports, listSymbols } from '../../../src/store/usages.js';
import { copyFixture, tmpDir, writeTree } from '../../helpers.js';

let engine: Engine;
let repo: string;
let runId: string;
const target = { source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } };

beforeAll(async () => {
  engine = createEngine({ out: tmpDir() });
  repo = copyFixture('next-basic');
  writeTree(repo, {
    'lib/session.ts': "import { cookies } from 'next/headers';\nexport const session = () => cookies();\n",
    'app/a/page.tsx': "import { session } from '../../lib/session';\nexport default function A({ params }) { session(); return params; }\n",
    'app/load.ts': 'export const load = (n: string) => import(n);\n',
    'app/broken.ts': 'export function x( {\n',
    'styles/a.scss': "@import '~x';\n",
  });
  const scan = await scanRepo(engine, { repo_path: repo, ...target });
  runId = scan.run!.run_id;
});
afterAll(() => closeEngine(engine));

const expectInputError = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InputError);
  expect((err as InputError).code).toBe(code);
};

describe('find_usages', () => {
  it('returns every usage on one page when it fits, and says it is not paginated', async () => {
    const out = await findUsages(engine, { run_id: runId });
    expect(out.total).toBe(out.usages.length);
    expect(out).toMatchObject({ paginated: false, next_cursor: null, note: null, returned: out.total });
    expect(out.summary.total).toBe(out.total);
    expect(out.usages.map((u) => u.kind)).toEqual(expect.arrayContaining(['request_api', 'request_props', 'unresolved_dynamic', 'sass_tilde_import']));
  });

  it('paginates with a total, a note and a cursor, and the pages add up to the whole list', async () => {
    const all = (await findUsages(engine, { run_id: runId })).usages;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await findUsages(engine, { run_id: runId, limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(all.length);
      expect(page.paginated).toBe(true);
      expect(page.note).toContain(`of ${all.length}`);
      seen.push(...page.usages.map((u) => u.id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(Math.ceil(all.length / 3));
    expect(seen).toEqual(all.map((u) => u.id));
  });

  it('refuses a stale cursor, a cursor used with other filters, and a forged one', async () => {
    const first = await findUsages(engine, { run_id: runId, limit: 1 });
    await expectInputError(findUsages(engine, { run_id: runId, limit: 1, kind: 'request_api', cursor: first.next_cursor! }), 'cursor_filter_mismatch');
    await expectInputError(findUsages(engine, { run_id: runId, cursor: 'not-a-cursor' }), 'bad_cursor');
    await findUsages(engine, { run_id: runId });
    await expectInputError(findUsages(engine, { run_id: runId, limit: 1, cursor: first.next_cursor! }), 'stale_cursor');
  });

  it('filters by kind, file and symbol', async () => {
    const byKind = await findUsages(engine, { run_id: runId, kind: 'request_api' });
    expect(byKind.usages.every((u) => u.kind === 'request_api')).toBe(true);
    expect(byKind.usages.map((u) => u.file)).toEqual(['app/a/page.tsx', 'app/page.tsx', 'lib/session.ts']);
    const byFile = await findUsages(engine, { run_id: runId, file: 'lib/session.ts' });
    expect(byFile.usages.map((u) => u.file)).toEqual(['lib/session.ts']);
    const bySymbol = await findUsages(engine, { run_id: runId, symbol: 'next/headers.cookies' });
    expect(bySymbol.total).toBe(3);
  });

  it('refuses a run this engine has not opened', async () => {
    await expectInputError(findUsages(engine, { run_id: '01UNKNOWN' }), 'unknown_run');
  });

  it('records the time as a usages.result event, and stores the import graph and symbols', async () => {
    await findUsages(engine, { run_id: runId });
    const db = openSession(engine, repo).db;
    const results = listEvents(db, runId).filter((e) => e.kind === 'usages.result');
    const last = JSON.parse(results.at(-1)!.payload_json) as { duration_ms: number; adapter: string };
    expect(last.adapter).toBe('nextjs@1');
    expect(last.duration_ms).toBeGreaterThanOrEqual(0);
    expect(listImports(db, runId)).toContainEqual(expect.objectContaining({ from_file: 'app/a/page.tsx', to_file: 'lib/session.ts', kind: 'import' }));
    expect(listSymbols(db, runId, 'session')).toEqual([{ name: 'session', file: 'lib/session.ts', line: 2, kind: 'variable' }]);
  });

  it('re-uses cached facts for unchanged files and re-parses only a changed one', async () => {
    const again = await findUsages(engine, { run_id: runId });
    expect(again.summary.files.parsed).toBe(0);
    const cached = again.summary.files.cached;
    writeFileSync(path.join(repo, 'lib/session.ts'), "import { cookies } from 'next/headers';\nexport const session = async () => await cookies();\n");
    const changed = await findUsages(engine, { run_id: runId });
    expect(changed.summary.files).toMatchObject({ parsed: 1, cached: cached - 1 });
    expect(changed.usages.find((u) => u.file === 'lib/session.ts')!.labels).toEqual(['awaited']);
  });

  it('drops nothing silently: every walked file is parsed, cached, unparsed, text-only or under listed build output', async () => {
    writeTree(repo, { '.next/server/x.js': 'module.exports = 1;\n' });
    const scan = await scanRepo(engine, { repo_path: repo, ...target });
    const out = await findUsages(engine, { run_id: runId });
    const s = out.summary;
    const unparsedWhole = s.unparsed_files.filter((f) => !f.partial).length;
    const generated = 1; // .next/server/x.js
    expect(s.files.parsed + s.files.cached + unparsedWhole + s.files.text_only + generated).toBe(scan.scan!.files.read);
    expect(s.skipped_generated).toEqual(['.next/']);
    expect(s.unparsed_files.map((f) => f.file)).toEqual(['app/broken.ts']);
    // Every unresolved dynamic import in the summary is also a usage.
    expect(s.unresolved_dynamic.map((d) => `${d.file}:${d.line}`)).toEqual(
      out.usages.filter((u) => u.kind === 'unresolved_dynamic').map((u) => `${u.file}:${u.line_start}`),
    );
  });

  it('builds the import graph and returns no usages for a library no pack covers yet (Django)', async () => {
    const django = copyFixture('django-basic');
    const scan = await scanRepo(engine, { repo_path: django, source: { name: 'django' }, target: { name: 'django', version: '4.2.30' } });
    const out = await findUsages(engine, { run_id: scan.run!.run_id });
    expect(out.total).toBe(0);
    expect(out.summary.adapter).toBe('none@1');
    const db = openSession(engine, django).db;
    expect(listImports(db, scan.run!.run_id).filter((i) => i.to_file !== null).length).toBeGreaterThan(0);
  });
});
