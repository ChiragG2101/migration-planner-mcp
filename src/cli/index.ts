#!/usr/bin/env node
// The CLI adapter. Commands mirror the tools; `mcp` starts the MCP adapter
// with the same flags. JSON goes to stdout, everything else to stderr.
// Exit codes: 0 ok, 1 bad input or error, 2 refused, 3 a question to answer.
import { parseArgs } from 'node:util';
import {
  assessRisk,
  closeEngine,
  createEngine,
  emitPlan,
  ENGINE_VERSION,
  findUsages,
  getMigrationDocs,
  getRulePack,
  ingest,
  InputError,
  mergeFindings,
  NotBuiltError,
  parseLevel,
  PermissionError,
  proposeScope,
  scanRepo,
  setScope,
  validatePlan,
  type EngineOptions,
} from '../core/index.js';
import { formatMergeText, formatValidateText, formatEmitText } from './plan.js';
import { SetScopeInput } from '../schema/scope.js';
import { readOperatorFile } from '../security/operatorFile.js';
import { startMcpServer } from '../server.js';
import { formatDocsText } from './docs.js';
import { formatPackText } from './pack.js';
import { formatRiskText } from './risk.js';
import { formatScanText, scanInput } from './scan.js';
import { formatProposalText, formatScopeText } from './scope.js';
import { formatUsagesText, usagesFilter } from './usages.js';

const usage = `migration-planner-mcp ${ENGINE_VERSION}

Usage:
  migration-planner-mcp scan <repo> --source <lib@ver> --target <lib@ver> [--campaign <id>] [--format json|text]
  migration-planner-mcp usages <repo> --source <lib@ver> --target <lib@ver> [--kind <k>] [--file <f>] [--symbol <s>]
                         [--limit <n>] [--cursor <c>] [--format json|text]
  migration-planner-mcp pack <repo> --source <lib@ver> --target <lib@ver> [--format json|text]
  migration-planner-mcp risk <repo> --source <lib@ver> --target <lib@ver> [--format json|text]
  migration-planner-mcp scope <repo> --source <lib@ver> --target <lib@ver> [--answers <file.json>] [--small-max <n>] [--format json|text]
  migration-planner-mcp docs <repo> --source <lib@ver> --target <lib@ver> [--register <file.json>] [--query <file.json>] [--format json|text]
  migration-planner-mcp merge <repo> --source <lib@ver> --target <lib@ver> [--answers <file.json>] [--format json|text]
  migration-planner-mcp validate <repo> --source <lib@ver> --target <lib@ver> [--answers <file.json>] [--format json|text]
  migration-planner-mcp emit <repo> --source <lib@ver> --target <lib@ver> [--answers <file.json>] [--format json|text]
  migration-planner-mcp mcp

Shared flags:
  --out <dir>      output folder (default: .migration-planner/ next to the repo; never inside it)
  --level <0|1>    autonomy level (default 0; 2 is not built in v0.1)
  --db <path>      SQLite store (default: <out>/store.sqlite)
  --rules-dir <d>  knowledge and packs (only the bundled ones in v0.1)
`;

const err = (message: string): void => void process.stderr.write(`${message}\n`);

function readJsonArray(file: string, flag: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOperatorFile(file));
  } catch (e) {
    throw new InputError('bad_json', `could not read ${flag}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new InputError('bad_json', `${flag} must be a JSON array`);
  return parsed;
}

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
      answers: { type: 'string' },
      'small-max': { type: 'string' },
      register: { type: 'string' },
      query: { type: 'string' },
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
    case 'pack':
    case 'risk':
    case 'scope': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', `${command} needs a repo path`);
      const engine = createEngine(options);
      try {
        const scan = await scanRepo(engine, scanInput(rest, values));
        if (scan.status !== 'ok' || !scan.run) {
          process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
          return 3;
        }
        const run_id = scan.run.run_id;
        if (command === 'pack') {
          const out = await getRulePack(engine, { run_id });
          process.stdout.write(values.format === 'text' ? `${formatPackText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
          return 0;
        }
        await findUsages(engine, { run_id });
        if (command === 'risk') {
          const out = await assessRisk(engine, { run_id });
          process.stdout.write(values.format === 'text' ? `${formatRiskText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
          return 0;
        }
        const small = values['small-max'] === undefined ? undefined : Number(values['small-max']);
        if (small !== undefined && !Number.isInteger(small)) throw new InputError('bad_small_max', '--small-max must be a positive integer');
        if (!values.answers) {
          const out = await proposeScope(engine, { run_id, ...(small !== undefined ? { small_max_usages: small } : {}) });
          process.stdout.write(values.format === 'text' ? `${formatProposalText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
          return 0;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(readOperatorFile(values.answers));
        } catch (err) {
          throw new InputError('bad_answers', `could not read --answers: ${err instanceof Error ? err.message : String(err)}`);
        }
        const answers = SetScopeInput.shape.answers.safeParse(parsed);
        if (!answers.success) throw new InputError('bad_answers', 'the answers file must be the answers object, with only the offered question ids');
        if (small !== undefined) await proposeScope(engine, { run_id, small_max_usages: small });
        const out = await setScope(engine, { run_id, answers: answers.data });
        process.stdout.write(values.format === 'text' ? `${formatScopeText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
    case 'mcp':
      await startMcpServer(options);
      return -1;
    case 'docs': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'docs needs a repo path');
      const engine = createEngine(options);
      try {
        const scan = await scanRepo(engine, scanInput(rest, values));
        if (scan.status !== 'ok' || !scan.run) {
          process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
          return 3;
        }
        const run_id = scan.run.run_id;
        await findUsages(engine, { run_id });
        await getRulePack(engine, { run_id });
        const register = values.register ? readJsonArray(values.register, '--register') : undefined;
        const query = values.query ? readJsonArray(values.query, '--query') : undefined;
        const out = await getMigrationDocs(engine, { run_id, ...(register ? { register } : {}), ...(query ? { query } : {}) });
        process.stdout.write(values.format === 'text' ? `${formatDocsText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
    case 'merge':
    case 'validate':
    case 'emit': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', `${command} needs a repo path`);
      const engine = createEngine(options);
      try {
        const scan = await scanRepo(engine, scanInput(rest, values));
        if (scan.status !== 'ok' || !scan.run) {
          process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
          return 3;
        }
        const run_id = scan.run.run_id;
        await findUsages(engine, { run_id });
        await getRulePack(engine, { run_id });
        await proposeScope(engine, { run_id });
        if (values.answers) {
          let parsedAnswers: unknown;
          try {
            parsedAnswers = JSON.parse(readOperatorFile(values.answers));
          } catch (e) {
            throw new InputError('bad_answers', `could not read --answers: ${e instanceof Error ? e.message : String(e)}`);
          }
          const answers = SetScopeInput.shape.answers.safeParse(parsedAnswers);
          if (!answers.success) throw new InputError('bad_answers', 'the answers file must be the answers object, with only the offered question ids');
          await setScope(engine, { run_id, answers: answers.data });
        } else {
          await setScope(engine, { run_id, answers: {} });
        }
        const merge = await mergeFindings(engine, { run_id });
        if (command === 'merge') {
          process.stdout.write(values.format === 'text' ? `${formatMergeText(merge)}\n` : `${JSON.stringify(merge, null, 2)}\n`);
          return 0;
        }
        const validated = await validatePlan(engine, { run_id });
        if (command === 'validate') {
          process.stdout.write(values.format === 'text' ? `${formatValidateText(validated)}\n` : `${JSON.stringify(validated, null, 2)}\n`);
          return 0;
        }
        const emitted = await emitPlan(engine, { run_id });
        process.stdout.write(values.format === 'text' ? `${formatEmitText(emitted)}\n` : `${JSON.stringify(emitted, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
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
