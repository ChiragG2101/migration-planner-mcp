// INV-35: fetched_by and official are computed, and an unofficial doc is never shown as verified.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../helpers.js';
import { getMigrationDocs } from '../../../src/core/index.js';
import { describeDoc } from '../../../src/docs/cache.js';
import { DOCS_UNVERIFIED, docsUnverifiedBadge } from '../../../src/docs/format.js';
import { docRefAccepted, listRunDocs } from '../../../src/store/docs.js';
import { prepare } from './prepare.js';

const official = 'https://nextjs.org/docs/app/guides/upgrading/version-15#async-request-apis-breaking-change';
const lookalikes = [
  'https://nextjs.org.evil.com/docs/x',
  'http://nextjs.org/docs/x',
  'https://user:pass@nextjs.org/docs/x',
  'https://github.com/vercel/next.js-fork/blob/canary/docs/x',
  'https://nextjs.org/docs/../evil',
];

let close: () => void = () => {};
afterEach(() => close());

describe('doc source labels', () => {
  it('a registered doc is fetched_by agent, and a doc under doc_sources is official', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: [{ library: 'next', version: '15', topic: 'cookies', url: official, content: 'cookies() is async.' }],
    });
    expect(out.docs[0]).toMatchObject({ fetched_by: 'agent', official: true, status: 'fresh' });
    expect(out.limits.join(' ')).toContain('not fetched by the engine');
    expect(docsUnverifiedBadge(out.docs)).toBe(false);
  });

  it('an engine-fetched doc is fetched_by engine', async () => {
    const prep = await prepare({
      docs: {
        transport: {
          async fetch() {
            return { ok: true, url: official, content: 'cookies() is async.' };
          },
        },
      },
    });
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId, query: [{ library: 'next', version: '15.1.0', symbol: 'cookies' }] });
    expect(out.docs[0]).toMatchObject({ fetched_by: 'engine', official: true, status: 'fresh' });
    expect(out.limits.join(' ')).toContain('Context7');
  });

  it('look-alike hosts, http, credentials, a sibling repo and a .. path are unofficial and unverified', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: lookalikes.map((url, i) => ({ library: 'next', version: '15', topic: `bad-${i}`, url, content: `page ${i}` })),
    });
    expect(out.docs).toHaveLength(lookalikes.length);
    for (const doc of out.docs) expect(doc).toMatchObject({ fetched_by: 'agent', official: false, status: 'unverified' });
    expect(docsUnverifiedBadge(out.docs)).toBe(true);
    expect(DOCS_UNVERIFIED).toBe('docs unverified');
  });

  it('a finding that cites only stale docs carries the badge, and one that cites nothing does not', () => {
    expect(docsUnverifiedBadge([{ status: 'stale' }])).toBe(true);
    expect(docsUnverifiedBadge([{ status: 'stale' }, { status: 'unverified' }])).toBe(true);
    expect(docsUnverifiedBadge([])).toBe(false);
  });

  it('a finding that also cites a fresh doc does not carry the badge', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: [
        { library: 'next', version: '15', topic: 'cookies', url: official, content: 'real' },
        { library: 'next', version: '15', topic: 'blog', url: 'https://blog.example/next', content: 'opinion' },
      ],
    });
    const unofficial = out.docs.filter((d) => !d.official);
    expect(docsUnverifiedBadge(unofficial)).toBe(true);
    expect(docsUnverifiedBadge(out.docs)).toBe(false);
  });

  it('with Context7 down, a fallback doc is knowledge, unverified, citable, and official only when the URL is', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId });
    expect(out.fallback).toEqual({ reason: 'unconfigured' });
    const rows = listRunDocs(prep.db(), prep.runId);
    expect(rows.length).toBe(out.docs.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const doc of out.docs) {
      expect(doc.fetched_by).toBe('knowledge');
      expect(doc.status).toBe('unverified');
      expect(doc.doc_id).toMatch(/^[a-f0-9]{64}$/);
      expect(docRefAccepted(rows, doc)).toBe(true);
    }
    const rule = out.docs.find((d) => d.url === official);
    expect(rule?.official).toBe(true);
    const reference = out.docs.find((d) => d.url.startsWith('pack://nextjs-upgrade@'));
    expect(reference).toMatchObject({ official: false, fetched_by: 'knowledge', status: 'unverified' });
    expect(reference!.url).toMatch(/^pack:\/\/nextjs-upgrade@0\.3\.0\/references\/.+\.md$/);
    expect(docsUnverifiedBadge(out.docs)).toBe(true);
    // A rule source outside doc_sources cannot be loaded (the pack lint rejects it).
    // The same function the fallback uses computes the label, so it is not assumed.
    const prefixes = JSON.parse(readFileSync(`${repoRoot}/knowledge/npm/next/library.json`, 'utf8')).doc_sources as string[];
    expect(describeDoc({ fetchedBy: 'knowledge', url: 'https://example.com/not-a-doc', prefixes, fresh: false })).toEqual({
      official: false,
      status: 'unverified',
    });
    expect(describeDoc({ fetchedBy: 'knowledge', url: official, prefixes, fresh: false })).toEqual({ official: true, status: 'unverified' });
  });
});
