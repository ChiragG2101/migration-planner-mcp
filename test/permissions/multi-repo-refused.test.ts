// INV-13 (C10): more than one repo is refused with "not built in v0.1".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, ingest, NotBuiltError, scanRepo, type Engine } from '../../src/core/index.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';
import { callTool, inMemoryClient, toolError } from '../mcp.js';

let a: string;
let b: string;
let engine: Engine;

beforeAll(() => {
  a = copyFixture('next-basic');
  b = copyFixture('django-basic');
  engine = createEngine({ out: tmpDir() });
});
afterAll(() => closeEngine(engine));

const input = (): Record<string, unknown> => ({
  repo_path: [a, b],
  source: { name: 'next' },
  target: { name: 'next', version: '15.1.0' },
});

describe('multi-repo', () => {
  it('core ingest and scanRepo refuse two repo paths', async () => {
    await expect(ingest(engine, input())).rejects.toThrow(NotBuiltError);
    await expect(ingest(engine, input())).rejects.toThrow('multi-repo campaigns not built in v0.1');
    await expect(scanRepo(engine, input())).rejects.toThrow('multi-repo campaigns not built in v0.1');
    expect(engine.sessions.size).toBe(0);
  });

  it('a one-element list is a single repo', async () => {
    const res = await ingest(engine, { ...input(), repo_path: [a] });
    expect(res.status).toBe('ok');
  });

  it('the MCP tool refuses it', async () => {
    const mcp = await inMemoryClient({ out: tmpDir() });
    try {
      const res = await callTool(mcp.client, 'scan_repo', input());
      expect(res.isError).toBe(true);
      expect(toolError(res)).toMatchObject({ name: 'NotBuiltError', message: 'multi-repo campaigns not built in v0.1' });
    } finally {
      await mcp.close();
    }
  });

  it('the CLI refuses two repo arguments', () => {
    const res = runCli(['scan', a, b, '--source', 'next', '--target', 'next@15.1.0', '--out', tmpDir()]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('multi-repo campaigns not built in v0.1');
  });
});
