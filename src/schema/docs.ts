// get_migration_docs input and output. One schema for the core and the MCP tool.
import { z } from 'zod';

export const DocStatus = z.enum(['fresh', 'stale', 'unverified']);
export const FetchedBy = z.enum(['engine', 'agent', 'knowledge']);
export const FallbackReason = z.enum(['timeout', '429', 'offline', 'unconfigured']);

export const RegisterDoc = z
  .object({
    library: z.string().trim().min(1),
    version: z.string().trim().min(1),
    topic: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1),
    content: z.string().min(1),
  })
  .strict();
export type RegisterDoc = z.infer<typeof RegisterDoc>;

export const QueryDoc = z
  .object({
    library: z.string().trim().min(1),
    version: z.string().trim().min(1),
    symbol: z.string().trim().min(1).max(200),
  })
  .strict();
export type QueryDoc = z.infer<typeof QueryDoc>;

export const GetMigrationDocsInput = z
  .object({
    run_id: z.string().min(1),
    register: z.array(RegisterDoc).optional().describe('Docs the host agent fetched from Context7 and is registering for this run.'),
    query: z.array(QueryDoc).optional().describe('Server-side lookups. Each item is a library, a version and a symbol.'),
  })
  .strict();
export type GetMigrationDocsInput = z.infer<typeof GetMigrationDocsInput>;

export const MigrationDoc = z
  .object({
    doc_id: z.string(),
    url: z.string(),
    library: z.string(),
    version: z.string(),
    topic: z.string(),
    status: DocStatus,
    fetched_by: FetchedBy,
    official: z.boolean(),
    text: z.string(),
  })
  .strict();
export type MigrationDoc = z.infer<typeof MigrationDoc>;

export const GetMigrationDocsOutput = z
  .object({
    docs: z.array(MigrationDoc),
    formatted: z.string(),
    fallback: z.object({ reason: FallbackReason }).strict().nullable(),
    limits: z.array(z.string()),
  })
  .strict();
export type GetMigrationDocsOutput = z.infer<typeof GetMigrationDocsOutput>;
