// INV-1 (C3): every tool and CLI command, run against both fixtures, leaves
// the repo hash identical. Covers the core API, the CLI (json and text), the
// MCP adapter in memory and over stdio, and the default --out beside the repo.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoHash } from '../../scripts/repo-hash.js';
import { closeEngine, createEngine, findUsages, ingest, scanRepo } from '../../src/core/index.js';
import { copyFixture, runCli, tmpDir, writeTree } from '../helpers.js';
import { callTool, inMemoryClient, stdioClient } from '../mcp.js';

const cases = [
  { fixture: 'next-basic', source: 'next', target: 'next@15.1.0', input: { source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } } },
  {
    fixture: 'django-basic',
    source: 'django',
    target: 'django@4.2.30',
    input: { source: { name: 'django' }, target: { name: 'django', version: '4.2.30' } },
  },
];

describe.each(cases)('$fixture is never written', ({ fixture, source, target, input }) => {
  it('by the core API (ingest, scanRepo, findUsages, and a question)', async () => {
    const repo = copyFixture(fixture);
    const before = repoHash(repo);
    const engine = createEngine({ out: tmpDir() });
    try {
      expect((await ingest(engine, { repo_path: repo, ...input })).status).toBe('ok');
      const scan = await scanRepo(engine, { repo_path: repo, ...input });
      expect(scan.status).toBe('ok');
      await findUsages(engine, { run_id: scan.run!.run_id });
      await findUsages(engine, { run_id: scan.run!.run_id, limit: 1 });
      expect((await scanRepo(engine, { repo_path: repo, target: input.target })).status).toBe('question');
    } finally {
      closeEngine(engine);
    }
    expect(repoHash(repo)).toBe(before);
  });

  it('by the CLI scan and usages commands, json and text', () => {
    const repo = copyFixture(fixture);
    const before = repoHash(repo);
    const out = tmpDir();
    expect(runCli(['usages', repo, '--source', source, '--target', target, '--out', out]).status).toBe(0);
    expect(runCli(['usages', repo, '--source', source, '--target', target, '--out', out, '--format', 'text']).status).toBe(0);
    expect(runCli(['scan', repo, '--source', source, '--target', target, '--out', out]).status).toBe(0);
    expect(runCli(['scan', repo, '--source', source, '--target', target, '--out', out, '--format', 'text']).status).toBe(0);
    expect(runCli(['scan', repo, '--source', source, '--target', target, '--out', out, '--level', '1']).status).toBe(0);
    expect(repoHash(repo)).toBe(before);
  });

  it('by the default --out, which goes beside the repo, not in it', () => {
    const parent = tmpDir();
    const repo = copyFixture(fixture, path.join(parent, 'repo'));
    const before = repoHash(repo);
    expect(runCli(['scan', repo, '--source', source, '--target', target]).status).toBe(0);
    expect(existsSync(path.join(parent, '.migration-planner', 'store.sqlite'))).toBe(true);
    expect(repoHash(repo)).toBe(before);
  });

  it('by the default --out when the repo is a package inside a larger git repo', () => {
    const base = tmpDir();
    const mono = path.join(base, 'mono');
    writeTree(mono, { '.git/HEAD': 'ref: refs/heads/main\n', 'README.md': 'outer repo\n' });
    const pkg = copyFixture(fixture, path.join(mono, 'packages', 'web'));
    const before = repoHash(mono);
    const res = runCli(['scan', pkg, '--source', source, '--target', target]);
    expect(res.status).toBe(0);
    expect(existsSync(path.join(base, '.migration-planner', 'store.sqlite'))).toBe(true);
    expect(existsSync(path.join(mono, 'packages', '.migration-planner'))).toBe(false);
    expect(res.stderr).toContain(`output folder: ${path.join(base, '.migration-planner')}`);
    expect(repoHash(mono)).toBe(before);
  });

  it('by the default --out when the repo is a submodule (a .git file) inside an outer repo', () => {
    const base = tmpDir();
    const outer = path.join(base, 'outer');
    writeTree(outer, { '.git/HEAD': 'ref: refs/heads/main\n', 'vendor/lib/.git': 'gitdir: ../../.git/modules/lib\n' });
    const lib = copyFixture(fixture, path.join(outer, 'vendor', 'lib', 'app'));
    const before = repoHash(outer);
    expect(runCli(['scan', lib, '--source', source, '--target', target]).status).toBe(0);
    expect(existsSync(path.join(base, '.migration-planner', 'store.sqlite'))).toBe(true);
    expect(repoHash(outer)).toBe(before);
  });

  it('by the default --out when the outermost marker is only a .git file (a linked worktree)', () => {
    const base = tmpDir();
    const linked = path.join(base, 'linked');
    writeTree(linked, { '.git': 'gitdir: /elsewhere/main/.git/worktrees/linked\n' });
    const pkg = copyFixture(fixture, path.join(linked, 'packages', 'web'));
    const before = repoHash(linked);
    expect(runCli(['scan', pkg, '--source', source, '--target', target]).status).toBe(0);
    expect(existsSync(path.join(base, '.migration-planner', 'store.sqlite'))).toBe(true);
    expect(existsSync(path.join(linked, 'packages', '.migration-planner'))).toBe(false);
    expect(repoHash(linked)).toBe(before);
  });

  it('by the MCP scan_repo and find_usages tools, in memory and over stdio', async () => {
    const repo = copyFixture(fixture);
    const before = repoHash(repo);
    const runIdOf = (r: Awaited<ReturnType<typeof callTool>>): string => (r.structuredContent as { run: { run_id: string } }).run.run_id;
    const mem = await inMemoryClient({ out: tmpDir() });
    try {
      const scan = await callTool(mem.client, 'scan_repo', { repo_path: repo, ...input });
      expect(scan.isError).toBeFalsy();
      expect((await callTool(mem.client, 'find_usages', { run_id: runIdOf(scan) })).isError).toBeFalsy();
    } finally {
      await mem.close();
    }
    const stdio = await stdioClient(['--out', tmpDir()]);
    try {
      const scan = await callTool(stdio.client, 'scan_repo', { repo_path: repo, ...input });
      expect(scan.isError).toBeFalsy();
      expect((await callTool(stdio.client, 'find_usages', { run_id: runIdOf(scan) })).isError).toBeFalsy();
    } finally {
      await stdio.close();
    }
    expect(repoHash(repo)).toBe(before);
  });
});
