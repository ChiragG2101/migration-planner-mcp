import { getMigrationDocs, GetMigrationDocsInput } from '../core/index.js';
import { GetMigrationDocsOutput } from '../schema/docs.js';
import type { ToolDef } from './index.js';

export const getMigrationDocsTool: ToolDef = {
  name: 'get_migration_docs',
  title: 'Get migration docs',
  description:
    'Records the docs for this run and returns them with a doc_id. ' +
    'Pass register for docs the agent fetched, or query for a library, version and symbol. ' +
    'With Context7 unconfigured or down, returns the cache or the rule pack and marks them stale or unverified. Read-only.',
  inputSchema: GetMigrationDocsInput,
  outputSchema: GetMigrationDocsOutput,
  handler: (engine, input) => getMigrationDocs(engine, input),
};
