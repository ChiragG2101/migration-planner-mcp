// Replay determinism and the full flow through HEAD's engine (M7 Tests: replay
// determinism, replay inputs, replay re-runs the engine, truth matching). Builds
// a tiny Next.js case at test time (a git repo), captures a recorded engine run
// by driving the engine once, then replays it with no model and no network.
import { cpSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  findUsages,
  getLensPacket,
  getMigrationDocs,
  proposeScope,
  scanRepo,
  setScope,
  type Engine,
} from '../../../src/core/index.js';
import { snippetHash, sliceLines } from '../../../src/analysis/snippet.js';
import { docId } from '../../../src/docs/cache.js';
import { readFileSync } from 'node:fs';
import { REPLAY_DOCS } from '../../../eval/engineRun.js';
import { replayBaselineRun, replayEngineRun } from '../../../eval/replay.js';
import type { BaselineRun, EngineRun, RecordedDoc, RecordedSubmission, Truth, UsageSpan } from '../../../eval/schema.js';
import { repoRoot, tmpDir } from '../../helpers.js';

/** A fetch that fails the test if the engine ever reaches the network under replay. */
const throwingFetch = (() => {
  throw new Error('replay reached the network (Context7 was not disabled)');
}) as unknown as typeof fetch;

const HOST = { product: 'claude-code', model: 'claude-opus-4-8' };

/** A base checkout: the seeded next-tricky repo in a temp dir. Replay reads it read-only. */
function makeCase(): string {
  const root = path.join(tmpDir(), 'nextjs-fixture');
  cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), root, { recursive: true });
  return root;
}

/**
 * Drive the engine once over `root` to capture a valid recorded engine run: it
 * fetches the api packet, builds a finding covering the first usage, submits,
 * merges and validates, and records the submission with the packet usage spans.
 * Returns the recorded run and the first usage's span (truth).
 */
async function record(engine: Engine, root: string): Promise<{ run: EngineRun; truthSpan: UsageSpan }> {
  const scan = await scanRepo(engine, { repo_path: root, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  const packet = (await getLensPacket(engine, { run_id: id, lens: 'api' })).packet;
  const usage = packet.usages[0]!;
  const finding = {
    id: 'f1',
    repo_id: packet.repo_id,
    lens: 'api' as const,
    concern: 'api_change' as const,
    severity: 'high' as const,
    evidence: [{ repo_id: packet.repo_id, file: usage.file, line_start: usage.line_start, line_end: usage.line_end, snippet_hash: usage.snippet_hash }],
    doc_refs: [],
    reasoning: 'The packet lists this usage.',
    action: 'Update the call.',
    step_kind: 'manual' as const,
    rollback: 'Revert the edit.',
    verify: 'Load the page.',
    confidence: 0.8,
    source: 'rule_pack' as const,
    usage_ids: [usage.id],
    docs_status: 'verified' as const,
    prompt_version: 'v1',
  };
  const sub: RecordedSubmission = {
    lens: 'api',
    packet_usages: packet.usages.map((u) => ({ usage_id: u.id, file: u.file, line_start: u.line_start, line_end: u.line_end, snippet_hash: u.snippet_hash })),
    submission: { findings: [finding], out_of_scope: [] },
  };
  const run: EngineRun = {
    kind: 'engine',
    case_id: 'nextjs-fixture',
    prompt_version: 'v1',
    run: 1,
    ingest: { source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } },
    scope_answers: {},
    docs: [],
    rounds: [{ submissions: [sub] }],
    size: 'full',
    cost_tokens: 1234,
    wall_ms: 5000,
    host: HOST,
  };
  return { run, truthSpan: { file: usage.file, line_start: usage.line_start, line_end: usage.line_end, snippet_hash: usage.snippet_hash } };
}

let recEngine: Engine;
let root: string;
let recorded: EngineRun;
let truth: Truth;

beforeAll(async () => {
  root = makeCase();
  recEngine = createEngine({ out: tmpDir(), docs: { apiKey: null } });
  const r = await record(recEngine, root);
  recorded = r.run;
  truth = {
    case_id: 'nextjs-fixture',
    base_commit: 'base',
    merge_commit: 'merge',
    changed_usages: [r.truthSpan],
    touched_files: [r.truthSpan.file],
    edit_size: { [r.truthSpan.file]: 10 },
    excluded_files: [],
  };
});
afterAll(() => closeEngine(recEngine));

describe('replay re-runs HEAD engine deterministically', () => {
  it('covers the truth usage and is byte-identical across two replays', async () => {
    const a = await replayEngineRun(recorded, truth, root);
    const b = await replayEngineRun(recorded, truth, root);
    expect(a.score.recall).toEqual({ found: 1, total: 1 });
    expect(JSON.stringify(a.score)).toBe(JSON.stringify(b.score));
    // cost and wall time come from the recording, never measured during re-scoring.
    expect(a.cost_tokens).toBe(1234);
    expect(a.wall_ms).toBe(5000);
  });

  it('matches recorded usage IDs to HEAD by span, so renumbered IDs change nothing', async () => {
    const renumbered: EngineRun = {
      ...recorded,
      rounds: [
        {
          submissions: recorded.rounds[0]!.submissions.map((s) => ({
            ...s,
            packet_usages: s.packet_usages.map((p, i) => ({ ...p, usage_id: `renum-${i}` })),
            submission: {
              ...s.submission,
              findings: (s.submission.findings as { usage_ids: string[] }[]).map((f) => ({ ...f, usage_ids: f.usage_ids.map(() => 'renum-0') })),
            },
          })),
        },
      ],
    };
    const r = await replayEngineRun(renumbered, truth, root);
    expect(r.score.recall).toEqual({ found: 1, total: 1 });
  });

  it('stops replaying a lens once it is accepted, ignoring extra recorded submissions', async () => {
    // The live agent may submit a lens twice (first rejected, second accepted).
    // After the second submission is accepted, the lens is closed. A third
    // submission (if the exporter stored one) must be silently skipped, not thrown.
    const sub = recorded.rounds[0]!.submissions[0]!;
    const extraRun: EngineRun = {
      ...recorded,
      rounds: [
        {
          submissions: [
            // First: will be accepted (same as the original).
            sub,
            // Second: same lens again — would throw "lens is closed" without the fix.
            { ...sub, submission: { findings: [], out_of_scope: [] } },
          ],
        },
      ],
    };
    // Should not throw; the second submission is skipped.
    const r = await replayEngineRun(extraRun, truth, root);
    expect(r.score.recall.found).toBeGreaterThan(0);
  });

  it('deduplicates out_of_scope entries when two recorded IDs remap to the same HEAD ID', async () => {
    // Two recorded packet_usages with different IDs but the same span (as happens when the
    // adapter merges spans between the live run and HEAD). Both appear in out_of_scope.
    // Without dedup, HEAD's engine rejects the submission with "marked more than once".
    const sub = recorded.rounds[0]!.submissions[0]!;
    const firstUsage = sub.packet_usages[0]!;
    const dupRun: EngineRun = {
      ...recorded,
      rounds: [
        {
          submissions: [
            {
              ...sub,
              // Two entries with the same span but different recorded IDs.
              packet_usages: [firstUsage, { ...firstUsage, usage_id: 'dup-id' }],
              submission: {
                findings: [],
                out_of_scope: [
                  { usage_id: firstUsage.usage_id, reason: 'no change needed' },
                  { usage_id: 'dup-id', reason: 'same span, different id' },
                ],
              },
            },
          ],
        },
      ],
    };
    // Should not throw a "marked more than once" error; the second entry is silently dropped.
    const r = await replayEngineRun(dupRun, truth, root);
    expect(r.flags.every((f) => f.kind !== 'submission_rejected')).toBe(true);
  });

  it('drops a recorded finding whose usage HEAD no longer finds, counting it a miss', async () => {
    const ghostTruth: Truth = {
      ...truth,
      changed_usages: [{ file: 'app/ghost.tsx', line_start: 1, line_end: 1, snippet_hash: 'f'.repeat(64) }],
      touched_files: ['app/ghost.tsx'],
    };
    const ghost: EngineRun = {
      ...recorded,
      rounds: [
        {
          submissions: recorded.rounds[0]!.submissions.map((s) => ({
            ...s,
            packet_usages: [{ usage_id: 'gone', file: 'app/ghost.tsx', line_start: 1, line_end: 1, snippet_hash: 'f'.repeat(64) }],
            submission: { findings: [{ ...(s.submission.findings[0] as object), usage_ids: ['gone'] }], out_of_scope: [] },
          })),
        },
      ],
    };
    const r = await replayEngineRun(ghost, ghostTruth, root);
    expect(r.score.recall.found).toBe(0);
    expect(r.flags.some((f) => f.kind === 'finding_dropped')).toBe(true);
  });
});

describe('baseline re-score', () => {
  it('scores from recorded Markdown alone and resolves citations against base files', () => {
    const file = truth.changed_usages[0]!.file;
    const md = `- **[high]** \`${file}:1\` — change it.\n- **[low]** \`app/ghost.tsx:2\` — invalid citation.`;
    const run: BaselineRun = {
      kind: 'baseline',
      case_id: 'nextjs-fixture',
      run: 1,
      markdown: md,
      prompt_hash: 'a'.repeat(64),
      cost_tokens: null,
      wall_ms: 10,
      host: HOST,
    };
    const r = replayBaselineRun(run, truth, new Set([file]));
    expect(r.score.recall).toEqual({ found: 1, total: 1 });
    // the invalid citation is counted as an invalid change finding (evidence validity < 100%).
    expect(r.score.evidence_validity.found).toBeLessThan(r.score.evidence_validity.total);
  });
});

describe('replay registers recorded docs with no network (INV-44, D17)', () => {
  // A recorded run whose round registers a doc and whose finding cites it by
  // the doc_id the engine will compute. Replay must re-register it and pass
  // gate 3 with no Context7 call. A throwing fetch is injected so any network
  // attempt fails the test.
  const docPage = {
    library: 'next',
    version: '16.0.0',
    topic: 'cookies',
    url: 'https://nextjs.org/docs/app/api-reference/functions/cookies',
    content: 'cookies() is async in Next.js 15+.',
  };
  const recordedDoc: RecordedDoc = {
    ...docPage,
    doc_id: docId(docPage.library, docPage.version, docPage.url, docPage.content),
    fetched_by: 'agent',
    official: true,
    status: 'fresh',
  };

  function runWithCitedDoc(): EngineRun {
    const span = truth.changed_usages[0]!;
    // Reuse the repo_id the base recorded finding carried, so the finding's and
    // evidence's repo_id match the run's repo at replay (C10, superRefine).
    const recordedFinding = recorded.rounds[0]!.submissions[0]!.submission.findings[0] as {
      repo_id: string;
      evidence: { repo_id: string }[];
    };
    const repoId = recordedFinding.repo_id;
    const finding = {
      id: 'f1',
      repo_id: repoId,
      lens: 'api' as const,
      concern: 'api_change' as const,
      severity: 'high' as const,
      evidence: [{ repo_id: repoId, file: span.file, line_start: span.line_start, line_end: span.line_end, snippet_hash: span.snippet_hash }],
      doc_refs: [{ library: docPage.library, version: docPage.version, url: docPage.url, doc_id: recordedDoc.doc_id }],
      reasoning: 'The packet lists this usage; the registered doc supports the change.',
      action: 'Await cookies().',
      step_kind: 'manual' as const,
      rollback: 'Revert the edit.',
      verify: 'Load the page.',
      confidence: 0.8,
      source: 'rule_pack' as const,
      usage_ids: recorded.rounds[0]!.submissions[0]!.submission.findings.length
        ? (recorded.rounds[0]!.submissions[0]!.submission.findings[0] as { usage_ids: string[] }).usage_ids
        : [],
      docs_status: 'verified' as const,
      prompt_version: 'v1',
    };
    const sub: RecordedSubmission = {
      ...recorded.rounds[0]!.submissions[0]!,
      submission: { findings: [finding], out_of_scope: [] },
    };
    return { ...recorded, docs: [recordedDoc], rounds: [{ submissions: [sub] }] };
  }

  it('re-registers the cited doc, covers truth and never touches the network', async () => {
    const run = runWithCitedDoc();
    const r = await replayEngineRun(run, truth, root, { fetch: throwingFetch });
    expect(r.score.recall).toEqual({ found: 1, total: 1 });
    // The finding's evidence resolved (gate 1) and its doc_ref was registered (gate 3),
    // so it is not dropped and no doc_refused/finding_dropped flag is raised.
    expect(r.flags.some((f) => f.kind === 'doc_refused' || f.kind === 'finding_dropped')).toBe(false);
  });

  it('REPLAY_DOCS forces Context7 off, so a query takes the offline fallback, not the network', async () => {
    // Prove the guard directly: with REPLAY_DOCS a query finds no transport and
    // falls back as "unconfigured"; flipping apiKey away from null builds a
    // transport that calls the (throwing) fetch and changes the reason, so this
    // assertion goes red under that mutation.
    const out = tmpDir();
    const engine = createEngine({ out, docs: { ...REPLAY_DOCS, fetch: throwingFetch } });
    try {
      const scan = await scanRepo(engine, { repo_path: root, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      const id = scan.run!.run_id;
      await findUsages(engine, { run_id: id });
      await proposeScope(engine, { run_id: id });
      await setScope(engine, { run_id: id, answers: {} });
      const res = await getMigrationDocs(engine, {
        run_id: id,
        query: [{ library: 'next', version: '16.0.0', symbol: 'cookies' }],
      });
      expect(res.fallback?.reason).toBe('unconfigured');
    } finally {
      closeEngine(engine);
    }
  });
});

// Ensure the normaliser used for truth matches what the engine hashes.
describe('snippet matching', () => {
  it('the truth span hash equals the engine hash of those lines', () => {
    const span = truth.changed_usages[0]!;
    const text = readFileSync(path.join(root, span.file), 'utf8');
    expect(snippetHash(sliceLines(text, span.line_start, span.line_end))).toBe(span.snippet_hash);
  });
});
