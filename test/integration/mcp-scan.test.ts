// An MCP client calls scan_repo on both fixtures; the CLI gives the same JSON;
// the run and the calls are rows in SQLite with campaign and repo IDs.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScanRepoOutput } from '../../src/schema/scan.js';
import { openDb } from '../../src/store/db.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';
import { callTool, inMemoryClient, stdioClient } from '../mcp.js';

describe('scan_repo over MCP', () => {
  it('next-basic: entrypoints, versions and test setup', async () => {
    const repo = copyFixture('next-basic');
    const out = tmpDir();
    const mcp = await inMemoryClient({ out });
    let result;
    try {
      const res = await callTool(mcp.client, 'scan_repo', { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } });
      expect(res.isError).toBeFalsy();
      result = ScanRepoOutput.parse(res.structuredContent);
    } finally {
      await mcp.close();
    }
    const scan = result.scan!;
    expect(scan.versions).toEqual({ source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '15.1.0' } });
    const p = scan.packages[0]!;
    expect(p.entrypoints.map((e) => [e.kind, e.path, e.confidence])).toEqual([
      ['next_app_router', 'app', 'exact'],
      ['next_config', 'next.config.mjs', 'exact'],
      ['server', 'server.js', 'heuristic'],
    ]);
    expect(p.tests).toEqual({
      runners: [{ name: 'vitest', evidence: ['dependency vitest', 'vitest.config.ts'] }],
      globs: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
      test_script: 'vitest run',
    });
    expect(p.tsconfig).toEqual({
      chain: ['tsconfig.json', 'tsconfig.base.json'],
      unresolved_extends: [],
      module: 'esnext',
      target: 'ES2017',
      paths: { '@/*': ['./*'] },
    });
    expect(p.dependencies.find((d) => d.name === 'react')).toMatchObject({ declared: '^18.3.1', resolved: '18.3.1' });

    const db = openDb(path.join(out, 'store.sqlite'));
    const rows = db
      .prepare('SELECT e.kind, r.campaign_id, r.repo_id FROM events e JOIN runs r ON r.id = e.run_id WHERE r.id = ? ORDER BY e.id')
      .all(result.run!.run_id) as { kind: string; campaign_id: string; repo_id: string }[];
    db.close();
    expect(rows.map((r) => r.kind)).toEqual(['tool.start', 'ingest.run', 'scan.result', 'tool.end']);
    for (const r of rows) expect(r).toMatchObject({ campaign_id: result.run!.campaign_id, repo_id: result.run!.repo_id });
  });

  it('django-basic: settings, manage.py, pytest-django and the lockfile version', async () => {
    const repo = copyFixture('django-basic');
    const mcp = await inMemoryClient({ out: tmpDir() });
    try {
      const res = await callTool(mcp.client, 'scan_repo', { repo_path: repo, source: { name: 'django' }, target: { name: 'django', version: '4.2.30' } });
      const scan = ScanRepoOutput.parse(res.structuredContent).scan!;
      expect(scan.versions.source.version).toBe('3.2.25');
      const p = scan.packages[0]!;
      expect(p.entrypoints.filter((e) => e.kind.startsWith('django')).map((e) => [e.kind, e.path, e.value])).toEqual([
        ['django_manage', 'manage.py', null],
        ['django_settings', 'mysite/settings.py', 'mysite.settings'],
      ]);
      expect(p.tests.runners.map((r) => r.name)).toEqual(['pytest', 'pytest-django', 'django']);
      expect(p.python_tools).toEqual({
        pytest: { ini_options: { DJANGO_SETTINGS_MODULE: 'mysite.settings', python_files: ['tests.py', 'test_*.py'] } },
        mypy: { plugins: ['mypy_django_plugin.main'] },
      });
    } finally {
      await mcp.close();
    }
  });
});

describe('CLI and MCP give the same JSON', () => {
  it.each([
    ['next-basic', 'next', 'next@15.1.0', { name: 'next', version: '15.1.0' }],
    ['django-basic', 'django', 'django@4.2.30', { name: 'django', version: '4.2.30' }],
  ])('%s', async (fixture, source, target, targetRef) => {
    const repo = copyFixture(fixture);
    const out = tmpDir();
    const cli = runCli(['scan', repo, '--source', source, '--target', target, '--out', out]);
    expect(cli.status).toBe(0);
    const fromCli = JSON.parse(cli.stdout) as unknown;
    const stdio = await stdioClient(['--out', out]);
    try {
      const res = await callTool(stdio.client, 'scan_repo', { repo_path: repo, source: { name: source }, target: targetRef });
      expect(res.structuredContent).toEqual(fromCli);
    } finally {
      await stdio.close();
    }
  });
});
