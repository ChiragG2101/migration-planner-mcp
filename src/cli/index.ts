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
  verifyStage,
  getVerifyReport,
  recordFeedback,
  type EngineOptions,
} from '../core/index.js';
import { parseChecksConfig } from '../verify/checks.js';
import { formatMergeText, formatValidateText, formatEmitText } from './plan.js';
import { SetScopeInput } from '../schema/scope.js';
import { readOperatorFile } from '../security/operatorFile.js';
import { startMcpServer } from '../server.js';
import { formatDocsText } from './docs.js';
import { feedbackInput, formatFeedbackText } from './feedback.js';
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
  migration-planner-mcp verify <repo> --source <lib@ver> --target <lib@ver> [--answers <file.json>] [--install "<cmd>"] [--check name="<cmd>"]
                         [--junit name=<path>] [--pass-env NAME] [--trust-repo-checks] [--format json|text]
  migration-planner-mcp report <repo> --source <lib@ver> --target <lib@ver> [--format json|text]
  migration-planner-mcp feedback <repo> --source <lib@ver> --target <lib@ver> --kind <k> --note "<text>"
                         [--finding <id>] [--stage <id>] [--file <f> --line <n>] [--format json|text]
  migration-planner-mcp mcp

Shared flags:
  --out <dir>      output folder (default: .migration-planner/ next to the repo; never inside it)
  --level <0|1>    autonomy level (default 0; 2 is not built in v0.1)
  --db <path>      SQLite store (default: <out>/store.sqlite)
  --rules-dir <d>  knowledge and packs (only the bundled ones in v0.1)
  --confidence-threshold <0..1>  findings below it go to "Needs human decision" (default 0.6)
  --budget-tokens <n>   run budget in reported tokens; lenses and stages past it are recorded as budget_cut
  --budget-seconds <n>  run budget in seconds since the run started
  --trust-repo-checks   use checks from the repo's AGENTS.md snippet when no --install or --check was given
  --confirm-target      plan the requested target when the snippet names a different one
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
      install: { type: 'string', multiple: true },
      check: { type: 'string', multiple: true },
      junit: { type: 'string', multiple: true },
      'pass-env': { type: 'string', multiple: true },
      sandbox: { type: 'string' },
      'sandbox-image': { type: 'string' },
      'confidence-threshold': { type: 'string' },
      'budget-tokens': { type: 'string' },
      'budget-seconds': { type: 'string' },
      'trust-repo-checks': { type: 'boolean' },
      'confirm-target': { type: 'boolean' },
      note: { type: 'string' },
      finding: { type: 'string' },
      stage: { type: 'string' },
      line: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stderr.write(usage);
    return values.help ? 0 : 1;
  }
  // Container sandbox mode was cut for v0.1 (D42, INV-63). Only 'clone' and
  // 'container' are recognised values; 'container' is refused by the engine.
  if (values.sandbox !== undefined && values.sandbox !== 'clone' && values.sandbox !== 'container') {
    throw new NotBuiltError(`--sandbox ${values.sandbox} is unknown (only 'clone' is built in v0.1); container mode was cut (D42)`);
  }
  const installRaw = (values.install as string[] | undefined) ?? [];
  const checkRaw = (values.check as string[] | undefined) ?? [];
  const checksConfig = parseChecksConfig(installRaw, checkRaw, (values.junit as string[] | undefined) ?? []);
  const options: EngineOptions = {
    level: parseLevel(values.level),
    log: err,
    checks: checksConfig.checks as import('../schema/verify.js').CheckConfig[],
    installs: checksConfig.install as import('../schema/verify.js').InstallConfig[],
    // Flags win over the snippet. The trust flag is process config, not a tool argument (D58).
    checksFromCli: installRaw.length > 0 || checkRaw.length > 0,
    trustRepoChecks: values['trust-repo-checks'] === true,
  };
  if (values.out) options.out = values.out;
  if (values.db) options.db = values.db;
  if (values['rules-dir']) options.rulesDir = values['rules-dir'];
  if (values['pass-env']) options.passEnv = values['pass-env'] as string[];
  if (values.sandbox === 'container') options.sandbox = 'container';
  const num = (flag: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) throw new InputError('bad_number', `${flag} must be a number, got "${v}"`);
    return n;
  };
  const threshold = num('--confidence-threshold', values['confidence-threshold']);
  if (threshold !== undefined) options.confidenceThreshold = threshold;
  const budgetTokens = num('--budget-tokens', values['budget-tokens']);
  const budgetSeconds = num('--budget-seconds', values['budget-seconds']);
  if (budgetTokens !== undefined || budgetSeconds !== undefined) {
    options.budget = { ...(budgetTokens !== undefined ? { tokens: budgetTokens } : {}), ...(budgetSeconds !== undefined ? { seconds: budgetSeconds } : {}) };
  }

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
    case 'verify': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'verify needs a repo path');
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
          try { parsedAnswers = JSON.parse(readOperatorFile(values.answers)); }
          catch (e) { throw new InputError('bad_answers', `could not read --answers: ${e instanceof Error ? e.message : String(e)}`); }
          const answers = SetScopeInput.shape.answers.safeParse(parsedAnswers);
          if (!answers.success) throw new InputError('bad_answers', 'the answers file must be the answers object');
          await setScope(engine, { run_id, answers: answers.data });
        } else {
          await setScope(engine, { run_id, answers: {} });
        }
        await mergeFindings(engine, { run_id });
        await validatePlan(engine, { run_id });
        await emitPlan(engine, { run_id });
        // Run verify for each stage automatically (CLI mode: codemods only, no agent patch).
        const storedPlan = (await import('../store/plans.js')).getPlan(
          engine.sessions.values().next().value!.db, run_id,
        );
        const plan = (storedPlan?.plan ?? { stages: [] }) as { stages: Array<{ id: string }> };
        const results: unknown[] = [];
        for (const stage of plan.stages) {
          const out = await verifyStage(engine, { run_id, stage_id: stage.id });
          results.push(out);
        }
        // Emit again so the plan, the checklists and run_report.md carry the L1 results and verify_report.json is written.
        await emitPlan(engine, { run_id });
        const report = await getVerifyReport(engine, { run_id });
        process.stdout.write(values.format === 'text'
          ? `verify complete: ${results.length} stages\n${JSON.stringify(report, null, 2)}\n`
          : `${JSON.stringify(report, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
    case 'report': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'report needs a repo path');
      const engine = createEngine(options);
      try {
        const scan = await scanRepo(engine, scanInput(rest, values));
        if (scan.status !== 'ok' || !scan.run) {
          process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
          return 3;
        }
        const out = await getVerifyReport(engine, { run_id: scan.run.run_id });
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return 0;
      } finally {
        closeEngine(engine);
      }
    }
    case 'feedback': {
      if (values.format !== 'json' && values.format !== 'text') throw new InputError('bad_format', '--format must be json or text');
      if (rest.length === 0) throw new InputError('missing_repo', 'feedback needs a repo path');
      const engine = createEngine(options);
      try {
        const ing = await ingest(engine, scanInput(rest, values));
        if (ing.status !== 'ok' || !ing.run) {
          process.stdout.write(`${JSON.stringify(ing, null, 2)}\n`);
          return 3;
        }
        const out = await recordFeedback(engine, feedbackInput(ing.run.run_id, values));
        process.stdout.write(values.format === 'text' ? `${formatFeedbackText(out)}\n` : `${JSON.stringify(out, null, 2)}\n`);
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
