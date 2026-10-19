// Lens packets: isolation, scope, bounds, and which lens a size allows (INV-42, INV-56).
import { cpSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, findUsages, getLensPacket, getMigrationDocs, proposeScope, scanRepo, setScope, submitFindings, type Engine } from '../../src/core/index.js';
import { listEvents } from '../../src/store/events.js';
import { packetUsageIds } from '../../src/store/findings.js';
import { openSession } from '../../src/core/engine.js';
import { SEPARATE_LENSES } from '../../src/schema/finding.js';
import { copyFixture, repoRoot, tmpDir, writeTree } from '../helpers.js';

let engine: Engine;

beforeAll(() => {
  engine = createEngine({ out: tmpDir() });
});
afterAll(() => closeEngine(engine));

async function ready(repo: string, target = '16.0.0'): Promise<{ id: string; repoId: string }> {
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: target } });
  expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  return { id, repoId: scan.run!.repo_id };
}

function smallRepo(): string {
  const repo = copyFixture('next-clean');
  writeTree(repo, {
    'lib/cache.ts': "import { unstable_cacheLife } from 'next/cache';\nexport const life = unstable_cacheLife;\n",
  });
  return repo;
}

describe('lens packets', () => {
  it('refuses every lens on a none run, and combined unless the run is small', async () => {
    const none = await ready(copyFixture('next-clean'));
    for (const lens of [...SEPARATE_LENSES, 'combined' as const]) {
      await expect(getLensPacket(engine, { run_id: none.id, lens })).rejects.toMatchObject({
        code: 'lens_refused',
        message: 'a none run has no lenses',
      });
    }
    const fullRoot = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), fullRoot, { recursive: true });
    const full = await ready(fullRoot);
    await expect(getLensPacket(engine, { run_id: full.id, lens: 'combined' })).rejects.toMatchObject({
      code: 'lens_refused',
      message: 'combined is only for a small run',
    });
    const small = await ready(smallRepo());
    const sized = await setScope(engine, { run_id: small.id, answers: {} });
    expect(sized.size).toBe('small');
    for (const lens of SEPARATE_LENSES) {
      await expect(getLensPacket(engine, { run_id: small.id, lens })).rejects.toMatchObject({
        code: 'lens_refused',
        message: 'a small run uses the combined lens',
      });
    }
    const combined = await getLensPacket(engine, { run_id: small.id, lens: 'combined' });
    expect(combined.packet.lens).toBe('combined');
    expect(combined.packet.usages.some((u) => u.symbol.includes('unstable_cacheLife'))).toBe(true);
    expect(combined.packet.truncated).toBeNull();
  });

  it('leaves a scope-excluded usage out of every packet, including combined', async () => {
    const repo = smallRepo();
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    const id = scan.run!.run_id;
    await findUsages(engine, { run_id: id });
    const proposed = await proposeScope(engine, { run_id: id });
    expect(proposed.questions.map((q) => q.id)).toContain('stop_at');
    const set = await setScope(engine, { run_id: id, answers: { stop_at: '15' } });
    expect(set.out_of_scope.length).toBeGreaterThan(0);
    const excluded = new Set(set.out_of_scope.map((o) => o.usage_id));
    const packet = await getLensPacket(engine, { run_id: id, lens: 'combined' });
    for (const usage of packet.packet.usages) expect(excluded.has(usage.id)).toBe(false);
    expect(JSON.stringify(packet.packet)).not.toContain([...excluded][0]!);
  });

  it('a full run packet for one lens contains no finding from another lens', async () => {
    const fullRoot = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), fullRoot, { recursive: true });
    const full = await ready(fullRoot);
    const api = await getLensPacket(engine, { run_id: full.id, lens: 'api' });
    const usage = api.packet.usages[0];
    expect(usage).toBeDefined();
    const dep = await getLensPacket(engine, { run_id: full.id, lens: 'dependency_build' });
    const submitted = await submitFindings(engine, {
      run_id: full.id,
      lens: 'api',
      findings: [
        {
          id: 'finding-from-api-lens',
          repo_id: full.repoId,
          lens: 'api',
          concern: 'api_change',
          severity: 'low',
          evidence: [{ repo_id: full.repoId, file: usage!.file, line_start: usage!.line_start, line_end: usage!.line_end, snippet_hash: usage!.snippet_hash }],
          doc_refs: [],
          reasoning: 'A packet rule covers this usage.',
          action: 'Update the call.',
          step_kind: 'manual',
          verify: 'Load the page.',
          confidence: 0.6,
          source: 'rule_pack',
          usage_ids: [usage!.id],
          docs_status: 'verified',
          prompt_version: 'v1',
        },
      ],
      out_of_scope: [],
    });
    expect(submitted.accepted, JSON.stringify(submitted.errors)).toBe(true);
    const again = await getLensPacket(engine, { run_id: full.id, lens: 'dependency_build' });
    const apiKinds = new Set(['request_api', 'request_props', 'cache_api', 'renamed_api', 'removed_api', 'runtime_config', 'removed_package', 'deprecated_import', 'internal_import', 'request_geo', 'middleware', 'react_removed_api', 'react_renamed_api', 'react_removed_import', 'react_legacy', 'react_types']);
    expect(api.packet.usages.length).toBeGreaterThan(0);
    expect(api.packet.usages.every((u) => apiKinds.has(u.kind))).toBe(true);
    expect(dep.packet.usages.some((u) => u.kind === 'dependency' || u.kind === 'peer_dependency')).toBe(true);
    expect(dep.packet.usages.some((u) => apiKinds.has(u.kind))).toBe(false);
    expect(JSON.stringify(dep.packet)).not.toContain('finding-from-api-lens');
    expect(JSON.stringify(again.packet)).not.toContain('finding-from-api-lens');
    expect(again.packet.usages.map((u) => u.id)).toEqual(dep.packet.usages.map((u) => u.id));
  });

  it('reports truncation and stays within the packet limit', async () => {
    const bounded = createEngine({ out: tmpDir(), packetMaxChars: 8_000 });
    try {
      const fullRoot = path.join(tmpDir(), 'next-tricky');
      cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), fullRoot, { recursive: true });
      const scan = await scanRepo(bounded, { repo_path: fullRoot, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      const id = scan.run!.run_id;
      await findUsages(bounded, { run_id: id });
      await proposeScope(bounded, { run_id: id });
      await setScope(bounded, { run_id: id, answers: {} });
      const packet = (await getLensPacket(bounded, { run_id: id, lens: 'api' })).packet;
      expect(packet.truncated).not.toBeNull();
      expect((packet.truncated?.usages ?? 0) + (packet.truncated?.rules ?? 0) + (packet.truncated?.symbols ?? 0)).toBeGreaterThan(0);
      expect(JSON.stringify(packet).length).toBeLessThanOrEqual(8_000);
      const stored = packetUsageIds(openSession(bounded, fullRoot).db, id, 'api');
      expect(stored).toEqual(packet.usages.map((u) => u.id));
      expect(packet.truncated!.usages).toBeGreaterThan(0);
    } finally {
      closeEngine(bounded);
    }
  });

  it('offers only symbols get_migration_docs accepts, and skips a deny-listed usage file', async () => {
    const repo = smallRepo();
    writeTree(repo, { '.env': 'TOKEN=packet-deny-secret\n' });
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    expect(scan.status).toBe('ok');
    const id = scan.run!.run_id;
    const repoId = scan.run!.repo_id;
    await findUsages(engine, { run_id: id });
    await proposeScope(engine, { run_id: id });
    await setScope(engine, { run_id: id, answers: {} });
    openSession(engine, repo).db.prepare(
      `INSERT INTO usages (run_id, repo_id, id, seq, file, line_start, line_end, snippet_hash, kind, symbol, module, match_kind, context, via_json, confidence, labels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, repoId, 'denied-env-usage', 9999, '.env', 1, 1, 'd'.repeat(64), 'react_types', 'JSX', 'react', null, 'import', '[]', 'high', '[]');
    const combined = (await getLensPacket(engine, { run_id: id, lens: 'combined' })).packet;
    expect(combined.skipped_denied).toContainEqual({ usage_id: 'denied-env-usage', code: 'denied' });
    expect(combined.usages.map((u) => u.file)).not.toContain('.env');
    const fullRoot = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), fullRoot, { recursive: true });
    const full = await ready(fullRoot);
    const symbols = new Map<string, { library: string; version: string; symbol: string }>();
    for (const lens of SEPARATE_LENSES) {
      const packet = (await getLensPacket(engine, { run_id: full.id, lens })).packet;
      for (const query of packet.symbols) symbols.set(`${query.library}\n${query.version}\n${query.symbol}`, query);
      expect(packet.symbols.some((q) => q.symbol.includes('import('))).toBe(false);
    }
    expect(symbols.size).toBeGreaterThan(0);
    for (const query of symbols.values()) {
      const docs = await getMigrationDocs(engine, { run_id: full.id, query: [query] });
      expect(docs.docs.length).toBeGreaterThan(0);
    }
  });

  it('freezes scope when the first packet is fetched', async () => {
    const repo = copyFixture('next-clean');
    const none = await ready(repo);
    const events = listEvents(openSession(engine, repo).db, none.id);
    expect(events.some((e) => e.kind === 'packet.fetched')).toBe(false);
    const fullRoot = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), fullRoot, { recursive: true });
    const full = await ready(fullRoot);
    await getLensPacket(engine, { run_id: full.id, lens: 'verification' });
    await expect(setScope(engine, { run_id: full.id, answers: {} })).rejects.toMatchObject({ code: 'scope_frozen' });
  });
});
