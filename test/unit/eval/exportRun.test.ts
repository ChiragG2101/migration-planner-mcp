// The run exporter reads a real engine store. Dropping the packet spans would
// make replay miss the usage this test submits, because replay remaps findings
// by file, span and snippet_hash (D41).
import { cpSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  findUsages,
  getLensPacket,
  mergeFindings,
  proposeScope,
  scanRepo,
  setScope,
  submitFindings,
  validatePlan,
  type Engine,
} from '../../../src/core/index.js';
import { replayEngineRun } from '../../../eval/replay.js';
import type { Truth, UsageSpan } from '../../../eval/schema.js';
import { exportEngineRun } from '../../../scripts/export-run.js';
import { repoRoot, tmpDir } from '../../helpers.js';

const META = {
  caseId: 'nextjs-fixture',
  promptVersion: 'v1',
  run: 1,
  hostProduct: 'Claude Code',
  hostModel: 'claude-opus-5-5',
  costTokens: 10,
  wallMs: 20,
};

let engine: Engine;
let root: string;
let dbPath: string;
let span: UsageSpan;

beforeAll(async () => {
  root = path.join(tmpDir(), 'export-fixture');
  cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), root, { recursive: true });
  dbPath = path.join(tmpDir(), 'export-store.sqlite');
  engine = createEngine({ out: tmpDir(), db: dbPath, docs: { apiKey: null } });
  const scan = await scanRepo(engine, { repo_path: root, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  const packet = (await getLensPacket(engine, { run_id: id, lens: 'api' })).packet;
  const usage = packet.usages[0]!;
  span = { file: usage.file, line_start: usage.line_start, line_end: usage.line_end, snippet_hash: usage.snippet_hash };
  await submitFindings(engine, {
    run_id: id,
    lens: 'api',
    findings: [
      {
        id: 'f1',
        repo_id: packet.repo_id,
        lens: 'api',
        concern: 'api_change',
        severity: 'high',
        evidence: [{ repo_id: packet.repo_id, file: usage.file, line_start: usage.line_start, line_end: usage.line_end, snippet_hash: usage.snippet_hash }],
        doc_refs: [],
        reasoning: 'The packet lists this usage.',
        action: 'Update the call.',
        step_kind: 'manual',
        rollback: 'Revert the edit.',
        verify: 'Load the page.',
        confidence: 0.8,
        source: 'rule_pack',
        usage_ids: [usage.id],
        docs_status: 'verified',
        prompt_version: 'v1',
      },
    ],
    out_of_scope: [],
  });
  await mergeFindings(engine, { run_id: id });
  await validatePlan(engine, { run_id: id });
  closeEngine(engine);
});
afterAll(() => closeEngine(engine));

describe('exportEngineRun', () => {
  it('rebuilds a run that replay covers, with the packet span intact', async () => {
    const exported = exportEngineRun(dbPath, META);
    expect(exported.rounds[0]?.submissions[0]?.packet_usages.some((u) => u.snippet_hash === span.snippet_hash)).toBe(true);
    const truth: Truth = {
      case_id: 'nextjs-fixture',
      base_commit: 'base',
      merge_commit: 'merge',
      changed_usages: [span],
      touched_files: [span.file],
      edit_size: { [span.file]: 1 },
      excluded_files: [],
    };
    const scored = await replayEngineRun(exported, truth, root);
    expect(scored.score.recall.found).toBeGreaterThan(0);
  });

  it('refuses a run id the store does not hold', () => {
    expect(() => exportEngineRun(dbPath, { ...META, runId: 'missing' })).toThrow(/not in the store/);
  });
});
