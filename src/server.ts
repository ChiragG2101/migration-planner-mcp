// The MCP adapter over stdio. stdout carries only the protocol (INV-14); the
// banner and every log line go to stderr.
import { McpServer, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createEngine, ENGINE_VERSION, listPackReferences, readPackReference, type Engine, type EngineOptions } from './core/index.js';
import { Finding } from './schema/finding.js';
import { Plan } from './schema/plan.js';
import { loadPrompt } from './security/promptFile.js';
import { registerTools } from './tools/index.js';

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'migration-planner-mcp', version: ENGINE_VERSION });
  registerTools(server, engine);
  const prompt = loadPrompt();
  server.registerPrompt(
    'plan_migration',
    {
      title: 'Plan a migration',
      description: `Lens instructions (${prompt.version}). Requires a repo path, source@version and target@version; anything vaguer should be asked back.`,
      argsSchema: z
        .object({
          repo: z.string().optional().describe('Path to the repo. Ask if it was not given.'),
          source: z.string().optional().describe('Installed library as name@version. Ask if it was not given.'),
          target: z.string().optional().describe('Target library as name@version. Ask if it was not given.'),
        })
        .strict(),
    },
    (args) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [`prompt_version: ${prompt.version}`, `repo: ${args.repo ?? ''}`, `source: ${args.source ?? ''}`, `target: ${args.target ?? ''}`, '', prompt.body].join('\n'),
          },
        },
      ],
    }),
  );
  const schemaText = (schema: z.ZodType): string => JSON.stringify(z.toJSONSchema(schema));
  server.registerResource('finding-schema', 'schema://finding', { title: 'Finding schema', mimeType: 'application/schema+json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: schemaText(Finding) }],
  }));
  server.registerResource('plan-schema', 'schema://plan', { title: 'Plan schema', mimeType: 'application/schema+json' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/schema+json', text: schemaText(Plan) }],
  }));
  for (const ref of listPackReferences()) {
    server.registerResource(ref.name, ref.uri, { title: ref.title, mimeType: 'text/markdown' }, async (uri) => {
      const text = readPackReference(uri.href);
      if (text === null) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    });
  }
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
