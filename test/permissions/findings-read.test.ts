// submit_findings re-reads evidence only through SafePath (INV-4, INV-5).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoHash } from '../../scripts/repo-hash.js';
import { openSession } from '../../src/core/engine.js';
import { closeEngine, createEngine, findUsages, getLensPacket, proposeScope, scanRepo, setScope, submitFindings } from '../../src/core/index.js';
import { PermissionError } from '../../src/security/errors.js';
import { listFindings } from '../../src/store/findings.js';
import { copyFixture, tmpDir, writeTree } from '../helpers.js';

const SECRET = 'finding-evidence-secret-do-not-store';

describe('submit_findings evidence reads', () => {
  it('cannot read a deny-listed file or a file outside the repo', async () => {
    const repo = copyFixture('next-clean');
    writeTree(repo, {
      '.env': `TOKEN=${SECRET}\n`,
      'lib/cache.ts': "import { unstable_cacheLife } from 'next/cache';\nexport const life = unstable_cacheLife;\n",
    });
    writeFileSync(path.join(path.dirname(repo), 'secret.txt'), `${SECRET}\n`);
    const before = repoHash(repo);
    const engine = createEngine({ out: tmpDir() });
    try {
      const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
      const id = scan.run!.run_id;
      const repoId = scan.run!.repo_id;
      await findUsages(engine, { run_id: id });
      await proposeScope(engine, { run_id: id });
      const scope = await setScope(engine, { run_id: id, answers: {} });
      expect(scope.size).toBe('small');
      await getLensPacket(engine, { run_id: id, lens: 'combined' });
      const evidence = (file: string) => ({
        run_id: id,
        lens: 'combined' as const,
        findings: [
          {
            id: 'evil',
            repo_id: repoId,
            lens: 'combined',
            concern: 'config',
            severity: 'low',
            evidence: [{ repo_id: repoId, file, line_start: 1, line_end: 1, snippet_hash: 'c'.repeat(64) }],
            doc_refs: [],
            reasoning: 'Cited a forbidden file.',
            action: 'Leave it unread.',
            step_kind: 'manual',
            verify: 'The read is refused.',
            confidence: 0.2,
            source: 'agent_judgment',
            usage_ids: [],
            docs_status: 'verified',
            prompt_version: 'v1',
          },
        ],
        out_of_scope: [],
      });
      const denied = await submitFindings(engine, evidence('.env')).catch((err: unknown) => err);
      expect(denied).toBeInstanceOf(PermissionError);
      expect((denied as PermissionError).code).toBe('denied');
      const escaped = await submitFindings(engine, evidence('../secret.txt')).catch((err: unknown) => err);
      expect(escaped).toBeInstanceOf(PermissionError);
      expect((escaped as PermissionError).code).toBe('outside_root');
      const session = openSession(engine, repo);
      expect(listFindings(session.db, id)).toEqual([]);
      expect(readFileSync(session.dbPath).toString('utf8')).not.toContain(SECRET);
      expect(repoHash(repo)).toBe(before);
    } finally {
      closeEngine(engine);
    }
  });
});
