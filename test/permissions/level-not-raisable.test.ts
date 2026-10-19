// INV-6 (C5): no tool input has a level field, and a tool call carrying one
// leaves the process level where the CLI set it.
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertLevel, currentLevel } from '../../src/security/level.js';
import { tools } from '../../src/tools/index.js';
import { copyFixture, expectPermission, tmpDir } from '../helpers.js';
import { callTool, inMemoryClient, type TestClient } from '../mcp.js';

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

let mcp: TestClient;

beforeAll(async () => {
  mcp = await inMemoryClient({ out: tmpDir(), level: 0 });
});
afterAll(() => mcp.close());

describe('level is not raisable from a tool', () => {
  it('no tool input schema mentions a level', async () => {
    for (const tool of tools) {
      const json = z.toJSONSchema(tool.inputSchema);
      expect(keysDeep(json).filter((k) => /level|autonomy/i.test(k)), tool.name).toEqual([]);
    }
    const listed = await mcp.client.listTools();
    expect(listed.tools.length).toBe(tools.length);
    for (const t of listed.tools) expect(keysDeep(t.inputSchema).filter((k) => /level|autonomy/i.test(k)), t.name).toEqual([]);
  });

  it('a scan_repo call carrying level: 1 is rejected and the level stays 0', async () => {
    const repo = copyFixture('next-basic');
    const res = await callTool(mcp.client, 'scan_repo', {
      repo_path: repo,
      source: { name: 'next' },
      target: { name: 'next', version: '15.1.0' },
      level: 1,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/level/);
    expect(currentLevel()).toBe(0);
    expectPermission(() => assertLevel(1), 'level');
  });

  it('a level nested inside source or target is rejected too', async () => {
    const repo = copyFixture('next-basic');
    const res = await callTool(mcp.client, 'scan_repo', {
      repo_path: repo,
      source: { name: 'next', level: 1 },
      target: { name: 'next', version: '15.1.0' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/level/);
    expect(currentLevel()).toBe(0);
    expectPermission(() => assertLevel(1), 'level');
  });
});
