// The milestone's "done when" test: every way Context7 can fail still returns a doc.
import { afterEach, describe, expect, it } from 'vitest';
import { getMigrationDocs } from '../../../src/core/index.js';
import type { FetchResult, OutboundPayload } from '../../../src/docs/context7.js';
import { listEvents } from '../../../src/store/events.js';
import { listRunDocs } from '../../../src/store/docs.js';
import { prepare } from './prepare.js';

let close: () => void = () => {};
afterEach(() => close());

function scripted(results: FetchResult[], calls: OutboundPayload[] = []): { fetch: (p: OutboundPayload) => Promise<FetchResult>; calls: OutboundPayload[] } {
  return {
    calls,
    async fetch(payload) {
      calls.push(payload);
      const next = results[Math.min(calls.length, results.length) - 1]!;
      return next;
    },
  };
}

const query = [{ library: 'next', version: '15.1.0', symbol: 'cookies' }];

describe('Context7 fallback', () => {
  it('Context7 up stores a fresh engine doc and records no fallback', async () => {
    const calls: OutboundPayload[] = [];
    const prep = await prepare({
      docs: { transport: scripted([{ ok: true, url: 'https://nextjs.org/docs/app/api-reference/functions/cookies', content: 'async cookies()' }], calls) },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toBeNull();
    expect(out.docs[0]).toMatchObject({ status: 'fresh', fetched_by: 'engine', official: true });
    expect(calls).toEqual([{ library: 'next', version: '15.1.0', symbol: 'cookies' }]);
    const events = listEvents(prep.db(), prep.runId).map((e) => e.kind);
    expect(events).toContain('docs.retrieved');
    expect(events).not.toContain('docs.fallback');
    expect(listRunDocs(prep.db(), prep.runId).some((r) => r.doc_id === out.docs[0]!.doc_id)).toBe(true);
  });

  it('a timeout falls back to the rule pack and records docs.fallback', async () => {
    const prep = await prepare({ docs: { transport: scripted([{ ok: false, reason: 'timeout' }]) } });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toEqual({ reason: 'timeout' });
    expect(out.docs.length).toBeGreaterThan(0);
    expect(out.docs.every((d) => d.fetched_by === 'knowledge' && d.status === 'unverified')).toBe(true);
    const fallback = listEvents(prep.db(), prep.runId).find((e) => e.kind === 'docs.fallback');
    expect(JSON.parse(fallback!.payload_json)).toEqual({ reason: 'timeout' });
  });

  it('a 429 is retried once and then falls back', async () => {
    const calls: OutboundPayload[] = [];
    let slept = 0;
    const prep = await prepare({
      docs: {
        transport: scripted([{ ok: false, reason: '429' }, { ok: false, reason: '429' }], calls),
        sleep: async () => {
          slept += 1;
        },
      },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(calls).toHaveLength(2);
    expect(slept).toBe(1);
    expect(out.fallback).toEqual({ reason: '429' });
    expect(out.docs.every((d) => d.status === 'unverified' && d.fetched_by === 'knowledge')).toBe(true);
  });

  it('after a failed query the rest of the call skips Context7', async () => {
    const calls: OutboundPayload[] = [];
    let slept = 0;
    const prep = await prepare({
      docs: {
        transport: scripted([{ ok: false, reason: '429' }], calls),
        sleep: async () => {
          slept += 1;
        },
      },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      query: [...query, { library: 'next', version: '15.1.0', symbol: 'headers' }],
    });
    expect(calls).toEqual([query[0], query[0]]);
    expect(slept).toBe(1);
    expect(out.fallback).toEqual({ reason: '429' });
    expect(out.docs.some((d) => d.topic === 'headers' && d.fetched_by === 'knowledge')).toBe(true);
  });

  it('a 429 that clears on the retry is stored as fresh', async () => {
    const prep = await prepare({
      docs: {
        transport: scripted([
          { ok: false, reason: '429' },
          { ok: true, url: 'https://nextjs.org/docs/app/api-reference/functions/cookies', content: 'retried' },
        ]),
        sleep: async () => {},
      },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toBeNull();
    expect(out.docs[0]).toMatchObject({ status: 'fresh', fetched_by: 'engine' });
    expect(out.docs[0]!.text).toContain('retried');
  });

  it('offline falls back with that reason', async () => {
    const prep = await prepare({ docs: { transport: scripted([{ ok: false, reason: 'offline' }]) } });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toEqual({ reason: 'offline' });
    expect(out.docs[0]!.fetched_by).toBe('knowledge');
  });

  it('unconfigured makes no transport call and records unconfigured', async () => {
    const prep = await prepare({
      docs: {
        apiKey: null,
        transport: undefined,
      },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toEqual({ reason: 'unconfigured' });
    expect(out.docs.every((d) => d.status === 'unverified')).toBe(true);
  });

  it('a fresh cache hit is served as fresh when Context7 is down', async () => {
    const prep = await prepare();
    close = prep.close;
    await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: [{ library: 'next', version: '15.1.0', topic: 'cookies', url: 'https://nextjs.org/docs/app/api-reference/functions/cookies', content: 'cached page' }],
    });
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.fallback).toEqual({ reason: 'unconfigured' });
    const hit = out.docs.find((d) => d.topic === 'cookies' && d.version === '15.1.0');
    expect(hit).toMatchObject({ status: 'fresh', fetched_by: 'agent', official: true });
    expect(hit!.text).toContain('cached page');
  });

  it('a cache older than seven days is served as stale', async () => {
    const prep = await prepare({ now: () => new Date('2026-10-20T00:00:00Z') });
    close = prep.close;
    const { putCache } = await import('../../../src/store/docs.js');
    const { docId } = await import('../../../src/docs/cache.js');
    const content = 'old page';
    const url = 'https://nextjs.org/docs/app/api-reference/functions/cookies';
    putCache(prep.db(), {
      doc_id: docId('next', '15.1.0', url, content),
      library: 'next',
      version: '15.1.0',
      topic: 'cookies',
      url,
      content,
      fetched_at: '2026-10-01T00:00:00.000Z',
      source: 'engine',
    });
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    const hit = out.docs.find((d) => d.text.includes('old page'));
    expect(hit).toMatchObject({ status: 'stale', fetched_by: 'engine', official: true });
    expect(out.fallback).toEqual({ reason: 'unconfigured' });
  });

  it('an empty cache falls back to the rule pack', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query });
    expect(out.docs.length).toBeGreaterThan(0);
    expect(out.docs.every((d) => d.fetched_by === 'knowledge' && d.status === 'unverified' && d.doc_id.length === 64)).toBe(true);
    expect(listRunDocs(prep.db(), prep.runId).length).toBe(out.docs.length);
  });

  it('scan, usages, the rule pack and docs still finish when Context7 is unreachable', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId });
    expect(out.docs.length).toBeGreaterThan(0);
    expect(out.docs.every((d) => d.status === 'stale' || d.status === 'unverified')).toBe(true);
    expect(listEvents(prep.db(), prep.runId).some((e) => e.kind === 'docs.fallback')).toBe(true);
    const rows = listRunDocs(prep.db(), prep.runId);
    for (const doc of out.docs) expect(rows.some((r) => r.doc_id === doc.doc_id && r.fetched_by !== null && typeof r.official === 'boolean')).toBe(true);
  });
});
