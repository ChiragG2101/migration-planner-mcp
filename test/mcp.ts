// MCP clients for tests: in-memory (same process) and stdio (a real server process).
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { closeEngine, createEngine, type Engine, type EngineOptions } from '../src/core/index.js';
import { createMcpServer } from '../src/server.js';
import { mcpServerCommand } from './helpers.js';

export interface TestClient {
  client: Client;
  engine?: Engine;
  close(): Promise<void>;
}

export async function inMemoryClient(options: EngineOptions): Promise<TestClient> {
  const engine = createEngine(options);
  const server = createMcpServer(engine);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    engine,
    async close() {
      await client.close();
      await server.close();
      closeEngine(engine);
    },
  };
}

export async function stdioClient(flags: string[]): Promise<TestClient> {
  const { command, args } = mcpServerCommand(flags);
  const transport = new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), NODE_NO_WARNINGS: '1' }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text?: string }[];
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

/** The error payload of a refused tool call. */
export function toolError(result: ToolResult): { name: string; code?: string; message: string } {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return (JSON.parse(text) as { error: { name: string; code?: string; message: string } }).error;
}
