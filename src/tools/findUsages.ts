import { FindUsagesInput, FindUsagesOutput, findUsages } from '../core/index.js';
import type { ToolDef } from './index.js';

export const findUsagesTool: ToolDef = {
  name: 'find_usages',
  title: 'Find usages',
  description:
    'List every usage the migration pack cares about in a scanned run, with file:line, a snippet hash, context and ' +
    'the import chain for indirect usages. Read-only. Paginated: the result gives the total and a next_cursor. ' +
    'The summary lists unparsed files, unresolved dynamic imports and files skipped by the size limits.',
  inputSchema: FindUsagesInput,
  outputSchema: FindUsagesOutput,
  handler: (engine, input) => findUsages(engine, input),
};
