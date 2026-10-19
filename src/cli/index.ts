#!/usr/bin/env node
// The CLI adapter. Commands mirror the tools; `mcp` starts the MCP adapter
// with the same flags. JSON goes to stdout, everything else to stderr.
// Exit codes: 0 ok, 1 bad input or error, 2 refused, 3 a question to answer.
import { parseArgs } from 'node:util';
import {
  closeEngine,
  createEngine,
  ENGINE_VERSION,
  findUsages,
  ingest,
  InputError,
  NotBuiltError,
  parseLevel,
  PermissionError,
  scanRepo,
  type EngineOptions,
} from '../core/index.js';
import { startMcpServer } from '../server.js';
import { formatScanText, scanInput } from './scan.js';
import { formatUsagesText, usagesFilter } from './usages.js';

const usage = `migration-planner-mcp ${ENGINE_VERSION}

Usage:
  migration-planner-mcp scan <repo> --source <lib@ver> --target <lib@ver> [--campaign <id>] [--format json|text]
  migration-planner-mcp usages <repo> --source <lib@ver> --target <lib@ver> [--kind <k>] [--file <f>] [--symbol <s>]
                         [--limit <n>] [--cursor <c>] [--format json|text]
  migration-planner-mcp mcp

Shared flags:
  --out <dir>      output folder (default: .migration-planner/ next to the repo; never inside it)
  --level <0|1>    autonomy level (default 0; 2 is not built in v0.1)
  --db <path>      SQLite store (default: <out>/store.sqlite)
  --rules-dir <d>  knowledge and packs (only the bundled ones in v0.1)
`;

const err = (message: string): void => void process.stderr.write(`${message}\n`);

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      level: { type: 'string' },
      db: { type: 'string' },
      'rules-dir': { type: 'string' },
      source: { type: 'string' },
      target: { type: 'string' },
      campaign: { type: 'string' },
      kind: { type: 'string' },
      file: { type: 'string' },
      symbol: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      format: { type: 'string', default: 'json' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stderr.write(usage);
    return values.help ? 0 : 1;
  }
  const options: EngineOptions = { level: parseLevel(values.level), log: err };
  if (values.out) options.out = values.out;
  if (values.db) options.db = values.db;
  if (values['rules-dir']) options.rulesDir = values['rules-dir'];

  switch (command) {
    case 'scan': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'scan needs a repo path');
      const engine = createEngine(options);
      try {
        const out = await scanRepo(engine, scanInput(rest, values));
        process.stdout.write(values.format === 'text' ? `${formatScanText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
        return out.status === 'ok' ? 0 : 3;
      } finally {
        closeEngine(engine);
      }
    }
    case 'usages': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'usages needs a repo path');
      const engine = createEngine(options);
      try {
        const ing = await ingest(engine, scanInput(rest, values));
        if (ing.status !== 'ok' || !ing.run) {
          process.stdout.write(`${JSON.stringify(ing, null, 2)}\n`);
          return 3;
        }
        const out = await findUsages(engine, { run_id: ing.run.run_id, ...usagesFilter(values) });
        process.stdout.write(values.format === 'text' ? `${formatUsagesText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
    case 'mcp':
      await startMcpServer(options);
      return -1;
    default:
      throw new InputError('unknown_command', `unknown command "${command}"\n\n${usage}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof PermissionError || e instanceof NotBuiltError) {
      err(`refused: ${e.message}`);
      process.exitCode = 2;
    } else {
      err(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  },
);
