// INV-14 (C1): stdout is the MCP protocol channel. Every stdout line of a real
// server process parses as JSON-RPC; the banner and logs are on stderr.
import { spawn } from 'node:child_process';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { copyFixture, mcpServerCommand, tmpDir } from '../helpers.js';

describe('stdout carries only the protocol', () => {
  it('a scan_repo call over stdio prints only JSON-RPC on stdout', async () => {
    const repo = copyFixture('django-basic');
    const { command, args } = mcpServerCommand(['--out', tmpDir()]);
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; stdout so far:\n${stdout}\nstderr:\n${stderr}`)), 20_000);
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.split('\n').some((l) => l.includes('"id":2'))) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const send = (msg: object): boolean => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'scan_repo', arguments: { repo_path: repo, source: { name: 'django' }, target: { name: 'django', version: '4.2.30' } } },
    });
    try {
      await done;
    } finally {
      child.kill();
    }

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const msg = JSON.parse(line) as { jsonrpc?: string };
      expect(msg.jsonrpc).toBe('2.0');
    }
    const result = lines.map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean; structuredContent?: { status: string } } }).find((m) => m.id === 2);
    expect(result?.result?.isError).toBeFalsy();
    expect(result?.result?.structuredContent?.status).toBe('ok');
    expect(stderr).toContain('migration-planner-mcp');
    expect(stderr).toContain('MCP server on stdio');
    expect(stderr).toContain('output folder:');
  });
});
