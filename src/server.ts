// The MCP adapter over stdio. stdout carries only the protocol (INV-14); the
// banner and every log line go to stderr.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createEngine, ENGINE_VERSION, type Engine, type EngineOptions } from './core/index.js';
import { registerTools } from './tools/index.js';

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'migration-planner-mcp', version: ENGINE_VERSION });
  registerTools(server, engine);
  return server;
}

export async function startMcpServer(options: EngineOptions): Promise<void> {
  const log = (message: string): void => void process.stderr.write(`${message}\n`);
  const engine = createEngine({ ...options, log });
  const server = createMcpServer(engine);
  log(`migration-planner-mcp ${ENGINE_VERSION}: MCP server on stdio, level ${options.level ?? 0}`);
  log(`output folder: ${options.out ?? '.migration-planner/ next to each repo'} (never inside the repo)`);
  await server.connect(new StdioServerTransport());
}
