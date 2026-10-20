// Export one engine run's SQLite store into an EngineRun (D41). Replay then
// re-scores that file with no model and no network. The store holds the ingest
// arguments, scope answers, docs, lens submissions and packet spans. The host,
// token cost and wall time are not in the store: they come from the process
// that drove the run, and this script refuses to invent them.
//
//   npm run runs:export -- --db <store.sqlite> --case <id> --prompt-version <v> --run <n> \
//     --host-product <p> --host-model <m> --wall-ms <n> [--cost-tokens <n>] [--cli-version <v>] \
//     [--transcript <file>] [--run-id <id>] [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb, type Db } from '../src/store/db.js';
import { EngineRun, type RecordedDoc, type RecordedSubmission } from '../eval/schema.js';

export interface ExportMeta {
  caseId: string;
  promptVersion: string;
  run: number;
  hostProduct: string;
  hostModel: string;
  cliVersion?: string;
  /** Null when the host reported no token usage. */
  costTokens: number | null;
  wallMs: number;
  transcript?: string;
  /** Required when the store holds more than one run. */
  runId?: string;
}

interface Ev {
  id: number;
  step: string;
  kind: string;
  payload: unknown;
}

interface UsageRow {
  id: string;
  file: string;
  line_start: number;
  line_end: number;
  snippet_hash: string;
}

function eventsOf(db: Db, runId: string): Ev[] {
  const rows = db.prepare('SELECT id, step, kind, payload_json FROM events WHERE run_id = ? ORDER BY id').all(runId) as {
    id: number;
    step: string;
    kind: string;
    payload_json: string;
  }[];
  return rows.map((r) => ({ id: r.id, step: r.step, kind: r.kind, payload: JSON.parse(r.payload_json) as unknown }));
}

function inputOf(ev: Ev): Record<string, unknown> {
  const payload = ev.payload as { input?: unknown };
  if (!payload.input || typeof payload.input !== 'object') throw new Error(`${ev.step} tool.start has no input object`);
  return payload.input as Record<string, unknown>;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function packetUsages(db: Db, runId: string, lens: string): RecordedSubmission['packet_usages'] {
  const row = db.prepare('SELECT usage_ids_json FROM lens_packets WHERE run_id = ? AND lens = ?').get(runId, lens) as
    | { usage_ids_json: string }
    | undefined;
  if (!row) return [];
  const ids = JSON.parse(row.usage_ids_json) as string[];
  const usages = db.prepare('SELECT id, file, line_start, line_end, snippet_hash FROM usages WHERE run_id = ?').all(runId) as unknown as UsageRow[];
  const byId = new Map(usages.map((u) => [u.id, u]));
  return ids.map((id) => {
    const u = byId.get(id);
    if (!u) throw new Error(`lens ${lens} packet names usage ${id}, which is not in the usages table`);
    return { usage_id: u.id, file: u.file, line_start: u.line_start, line_end: u.line_end, snippet_hash: u.snippet_hash };
  });
}

function submissionOf(db: Db, runId: string, start: Ev): RecordedSubmission {
  const input = inputOf(start);
  const lens = input.lens;
  if (typeof lens !== 'string') throw new Error('submit_findings has no lens');
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const outOfScope = Array.isArray(input.out_of_scope) ? input.out_of_scope : [];
  return {
    lens: lens as RecordedSubmission['lens'],
    packet_usages: packetUsages(db, runId, lens),
    submission: { findings, out_of_scope: outOfScope },
  };
}

function docsOf(db: Db, runId: string): RecordedDoc[] {
  const rows = db
    .prepare(
      `SELECT c.library, c.version, c.topic, c.url, c.content, c.doc_id, r.fetched_by, r.official, r.status
       FROM run_docs r JOIN doc_cache c ON c.doc_id = r.doc_id
       WHERE r.run_id = ? ORDER BY c.doc_id`,
    )
    .all(runId) as {
    library: string;
    version: string;
    topic: string;
    url: string;
    content: string;
    doc_id: string;
    fetched_by: RecordedDoc['fetched_by'];
    official: number;
    status: RecordedDoc['status'];
  }[];
  return rows.map((r) => ({
    library: r.library,
    version: r.version,
    topic: r.topic,
    url: r.url,
    content: r.content,
    doc_id: r.doc_id,
    fetched_by: r.fetched_by,
    official: r.official === 1,
    status: r.status,
  }));
}

/** Read `dbPath` and return a schema-valid EngineRun. Throws when the store cannot support a replay. */
export function exportEngineRun(dbPath: string, meta: ExportMeta): EngineRun {
  const db = openDb(dbPath);
  try {
    const runs = db.prepare('SELECT id FROM runs ORDER BY created_at').all() as { id: string }[];
    const runId = meta.runId ?? (runs.length === 1 ? runs[0]!.id : undefined);
    if (!runId) throw new Error(`the store has ${runs.length} runs; pass --run-id`);
    if (!runs.some((r) => r.id === runId)) throw new Error(`run ${runId} is not in the store`);
    const events = eventsOf(db, runId);

    const scans = events.filter((e) => e.step === 'scan_repo' && e.kind === 'tool.start');
    const scan = scans.at(-1);
    if (!scan) throw new Error('run has no scan_repo call');
    const scanInput = inputOf(scan);

    const sets = events.filter((e) => e.step === 'set_scope' && e.kind === 'tool.start');
    const scopeEvent = events.filter((e) => e.kind === 'scope.set').at(-1);
    if (!scopeEvent) throw new Error('run has no scope.set event');
    const size = (scopeEvent.payload as { size?: unknown }).size;
    const rawAnswers = sets.at(-1) ? inputOf(sets.at(-1)!).answers : undefined;
    const scopeAnswers =
      rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? (rawAnswers as Record<string, unknown>)
        : ((scopeEvent.payload as { answers?: unknown }).answers as Record<string, unknown>);

    const rounds: { submissions: RecordedSubmission[] }[] = [];
    let pending: RecordedSubmission[] = [];
    let open: Ev | null = null;
    for (const ev of events) {
      if (ev.step === 'submit_findings' && ev.kind === 'tool.start') open = ev;
      if (ev.step === 'submit_findings' && ev.kind === 'tool.end' && open) {
        pending.push(submissionOf(db, runId, open));
        open = null;
      }
      if (ev.step === 'validate_plan' && ev.kind === 'tool.end') {
        rounds.push({ submissions: pending });
        pending = [];
      }
    }
    if (open || pending.length > 0) throw new Error('submit_findings was not closed by validate_plan');
    if (rounds.length === 0) throw new Error('run never called validate_plan');

    const host = {
      product: meta.hostProduct,
      model: meta.hostModel,
      ...(meta.cliVersion ? { cli_version: meta.cliVersion } : {}),
    };
    return EngineRun.parse({
      kind: 'engine',
      case_id: meta.caseId,
      prompt_version: meta.promptVersion,
      run: meta.run,
      ingest: { source: recordOf(scanInput.source, 'scan_repo source'), target: recordOf(scanInput.target, 'scan_repo target') },
      scope_answers: scopeAnswers,
      docs: docsOf(db, runId),
      rounds,
      size,
      cost_tokens: meta.costTokens,
      wall_ms: meta.wallMs,
      host,
      ...(meta.transcript !== undefined ? { transcript: meta.transcript } : {}),
    });
  } finally {
    db.close();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const required = (name: string): string => {
    const v = arg(name);
    if (!v) throw new Error(`missing ${name}`);
    return v;
  };
  const cost = arg('--cost-tokens');
  const transcript = arg('--transcript');
  const run = exportEngineRun(required('--db'), {
    caseId: required('--case'),
    promptVersion: required('--prompt-version'),
    run: Number(required('--run')),
    hostProduct: required('--host-product'),
    hostModel: required('--host-model'),
    ...(arg('--cli-version') ? { cliVersion: arg('--cli-version') } : {}),
    costTokens: cost === undefined ? null : Number(cost),
    wallMs: Number(required('--wall-ms')),
    ...(transcript ? { transcript: readFileSync(transcript, 'utf8') } : {}),
    ...(arg('--run-id') ? { runId: arg('--run-id') } : {}),
  });
  const json = `${JSON.stringify(run, null, 2)}\n`;
  const out = arg('--out');
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

if (process.argv[1]?.endsWith('export-run.ts')) main();
