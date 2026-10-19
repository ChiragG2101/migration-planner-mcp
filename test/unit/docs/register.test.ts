// Registered docs get a stable doc_id, and registering the same doc again adds no second row.
import { afterEach, describe, expect, it } from 'vitest';
import { getMigrationDocs } from '../../../src/core/index.js';
import { listRunDocs } from '../../../src/store/docs.js';
import { prepare } from './prepare.js';

const doc = {
  library: 'next',
  version: '15.1.0',
  topic: 'cookies',
  url: 'https://nextjs.org/docs/app/api-reference/functions/cookies',
  content: 'cookies() returns a promise in Next.js 15.',
};

let close: () => void = () => {};
afterEach(() => close());

describe('doc registration', () => {
  it('gives a stable doc_id and is idempotent on the same run', async () => {
    const prep = await prepare();
    close = prep.close;
    const first = await getMigrationDocs(prep.engine, { run_id: prep.runId, register: [doc] });
    const second = await getMigrationDocs(prep.engine, { run_id: prep.runId, register: [doc] });
    expect(first.docs).toHaveLength(1);
    expect(second.docs[0]!.doc_id).toBe(first.docs[0]!.doc_id);
    expect(first.docs[0]!.doc_id).toMatch(/^[a-f0-9]{64}$/);
    const rows = listRunDocs(prep.db(), prep.runId).filter((r) => r.doc_id === first.docs[0]!.doc_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fetched_by: 'agent', official: true, status: 'fresh', url: doc.url });
  });

  it('a different body is a different doc', async () => {
    const prep = await prepare();
    close = prep.close;
    const first = await getMigrationDocs(prep.engine, { run_id: prep.runId, register: [doc] });
    const second = await getMigrationDocs(prep.engine, { run_id: prep.runId, register: [{ ...doc, content: 'a different page' }] });
    expect(second.docs[0]!.doc_id).not.toBe(first.docs[0]!.doc_id);
    expect(listRunDocs(prep.db(), prep.runId)).toHaveLength(2);
  });

  it('refuses an empty body', async () => {
    const prep = await prepare();
    close = prep.close;
    await expect(getMigrationDocs(prep.engine, { run_id: prep.runId, register: [{ ...doc, content: '' }] })).rejects.toThrow(/content/i);
  });

  it('formats the installed version on the old side and the target on the new side', async () => {
    const prep = await prepare();
    close = prep.close;
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: [
        { ...doc, version: '14.2.35', content: 'cookies() returns the store.' },
        doc,
      ],
    });
    expect(out.formatted).toContain('### old (next@14.2.35)');
    expect(out.formatted).toContain('### new (next@15.1.0)');
    expect(out.formatted).toContain('cookies() returns the store.');
    expect(out.formatted).toContain('cookies() returns a promise');
    expect(out.docs.every((d) => d.doc_id.length === 64)).toBe(true);
  });
});
