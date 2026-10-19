// INV-1 (C3): an --out (or --db) inside the repo is refused before anything is
// created: the CLI exits, and an MCP ingest is refused with no run. The repo
// hash is unchanged either way.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoHash } from '../../scripts/repo-hash.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';
import { callTool, inMemoryClient, toolError } from '../mcp.js';

const args = (repo: string): Record<string, unknown> => ({
  repo_path: repo,
  source: { name: 'next' },
  target: { name: 'next', version: '15.1.0' },
});

describe('--out inside the repo', () => {
  it('the CLI refuses to start and leaves the repo untouched', () => {
    const repo = copyFixture('next-basic');
    const before = repoHash(repo);
    const res = runCli(['scan', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', path.join(repo, '.migration-planner')]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--out resolves inside the repo');
    expect(res.stdout).toBe('');
    expect(existsSync(path.join(repo, '.migration-planner'))).toBe(false);
    expect(repoHash(repo)).toBe(before);
  });

  it('the CLI refuses --out set to the repo root itself', () => {
    const repo = copyFixture('next-basic');
    const before = repoHash(repo);
    const res = runCli(['scan', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', repo]);
    expect(res.status).toBe(2);
    expect(existsSync(path.join(repo, 'store.sqlite'))).toBe(false);
    expect(repoHash(repo)).toBe(before);
  });

  it('the CLI refuses a --db inside the repo even with --out outside', () => {
    const repo = copyFixture('django-basic');
    const before = repoHash(repo);
    const res = runCli(['scan', repo, '--source', 'django', '--target', 'django@4.2', '--out', tmpDir(), '--db', path.join(repo, 'x.sqlite')]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--db resolves inside the repo');
    expect(existsSync(path.join(repo, 'x.sqlite'))).toBe(false);
    expect(repoHash(repo)).toBe(before);
  });

  it('an MCP ingest of a repo that contains --out is refused with no run and no store', async () => {
    const base = tmpDir();
    const repo = copyFixture('next-basic', path.join(base, 'app'));
    const out = path.join(repo, '.migration-planner');
    const before = repoHash(repo);
    const mcp = await inMemoryClient({ out });
    try {
      const res = await callTool(mcp.client, 'scan_repo', args(repo));
      expect(res.isError).toBe(true);
      expect(toolError(res)).toMatchObject({ name: 'PermissionError', code: 'out_inside_repo' });
      expect(mcp.engine!.sessions.size).toBe(0);
    } finally {
      await mcp.close();
    }
    expect(existsSync(out)).toBe(false);
    expect(repoHash(repo)).toBe(before);
  });
});
