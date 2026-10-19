// MCP tool registration, in one module so an SDK upgrade touches one file.
// Each tool is a thin wrapper: the SDK validates input with the Zod schema,
// the handler calls core, and refusals come back as tool errors.
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { errorPayload, type Engine } from '../core/index.js';
import { assessRiskTool } from './assessRisk.js';
import { findUsagesTool } from './findUsages.js';
import { getRulePackTool } from './getRulePack.js';
import { proposeScopeTool } from './proposeScope.js';
import { scanRepoTool } from './scanRepo.js';
import { setScopeTool } from './setScope.js';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  handler: (engine: Engine, input: unknown) => Promise<unknown>;
}

export const tools: readonly ToolDef[] = [scanRepoTool, findUsagesTool, getRulePackTool, assessRiskTool, proposeScopeTool, setScopeTool];

export function registerTools(server: McpServer, engine: Engine): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (input: unknown) => {
        try {
          const result = (await tool.handler(engine, input)) as Record<string, unknown>;
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: errorPayload(err) }) }] };
        }
      },
    );
  }
}
