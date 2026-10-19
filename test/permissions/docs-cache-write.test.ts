// Cache rows are SQLite rows under --out. The repo hash does not move.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoHash } from '../../scripts/repo-hash.js';
import { getMigrationDocs } from '../../src/core/index.js';
import { docId } from '../../src/docs/cache.js';
import { listCache, putCache } from '../../src/store/docs.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';
import { prepare } from '../unit/docs/prepare.js';

describe('doc cache writes', () => {
  it('the CLI docs command writes only the store under --out', () => {
    const repo = copyFixture('next-basic');
    const before = repoHash(repo);
    const out = tmpDir();
    const res = runCli(['docs', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', out, '--format', 'text'], {
      env: { CONTEXT7_API_KEY: '' },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('doc_id:');
    expect(res.stdout).toContain('fallback: unconfigured');
    expect(repoHash(repo)).toBe(before);
    for (const name of readdirSync(out)) expect(name.startsWith('store.sqlite')).toBe(true);
  });

  it('evicts cache content that no recent run cites, and keeps the run that just asked', async () => {
    const prep = await prepare({ docs: { apiKey: null, cacheMaxBytes: 200, protectRuns: 20 } });
    const repoBefore = repoHash(prep.repo);
    try {
      putCache(prep.db(), {
        doc_id: docId('next', '9.0.0', 'https://example.com/old', 'y'.repeat(5000)),
        library: 'next',
        version: '9.0.0',
        topic: 'old',
        url: 'https://example.com/old',
        content: 'y'.repeat(5000),
        fetched_at: '2020-01-01T00:00:00.000Z',
        source: 'agent',
      });
      const out = await getMigrationDocs(prep.engine, { run_id: prep.runId });
      expect(out.docs.length).toBeGreaterThan(0);
      expect(listCache(prep.db()).some((r) => r.topic === 'old')).toBe(false);
      expect(listCache(prep.db()).some((r) => out.docs.some((d) => d.doc_id === r.doc_id))).toBe(true);
      expect(repoHash(prep.repo)).toBe(repoBefore);
    } finally {
      prep.close();
    }
  });
});
