import { IngestInput, ScanRepoOutput, scanRepo } from '../core/index.js';
import type { ToolDef } from './index.js';

export const scanRepoTool: ToolDef = {
  name: 'scan_repo',
  title: 'Scan repo',
  description:
    'Ingest a repo for an upgrade (one repo, a source and target library) and return its facts: packages, ' +
    'dependency versions from lockfiles, entrypoints, test setup and config. Read-only. Vague or ambiguous ' +
    'input comes back as a question instead of a guess.',
  inputSchema: IngestInput,
  outputSchema: ScanRepoOutput,
  handler: (engine, input) => scanRepo(engine, input),
};
