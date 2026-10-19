// submit_findings: retry once, then a gap, and a third attempt is refused (INV-42).
import { cpSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, findUsages, findingsForRun, getLensPacket, InputError, proposeScope, scanRepo, setScope, submitFindings, type Engine } from '../../src/core/index.js';
import { listEvents } from '../../src/store/events.js';
import { openSession } from '../../src/core/engine.js';
import { listFindings, listMarks } from '../../src/store/findings.js';
import type { Usage } from '../../src/schema/usage.js';
import { repoRoot, tmpDir } from '../helpers.js';

let engine: Engine;

beforeAll(() => {
  engine = createEngine({ out: tmpDir() });
});
afterAll(() => closeEngine(engine));

async function fullRun(): Promise<{ id: string; repoId: string; repo: string; usage: Usage }> {
  const repo = path.join(tmpDir(), 'next-tricky');
  cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  expect(scan.status, JSON.stringify(scan.question)).toBe('ok');
  const id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  const packet = await getLensPacket(engine, { run_id: id, lens: 'api' });
  const usage = packet.packet.usages[0];
  expect(usage, 'api packet has a usage').toBeDefined();
  return { id, repoId: scan.run!.repo_id, repo, usage: usage! };
}

function finding(repoId: string, usage: Usage, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    repo_id: repoId,
    lens: 'api',
    concern: 'api_change',
    severity: 'low',
    evidence: [{ repo_id: repoId, file: usage.file, line_start: usage.line_start, line_end: usage.line_end, snippet_hash: usage.snippet_hash }],
    doc_refs: [],
    reasoning: 'The packet lists this usage.',
    action: 'Update the call.',
    step_kind: 'manual',
    verify: 'Load the page.',
    confidence: 0.7,
    source: 'rule_pack',
    usage_ids: [usage.id],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

describe('submit_findings', () => {
  it('stores a valid finding and an out-of-scope mark written by the lens', async () => {
    const run = await fullRun();
    const other = (await getLensPacket(engine, { run_id: run.id, lens: 'api' })).packet.usages[1];
    expect(other).toBeDefined();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [finding(run.repoId, run.usage)],
      out_of_scope: [{ usage_id: other!.id, reason: 'already in the target form' }],
    });
    expect(out.accepted, JSON.stringify(out.errors)).toBe(true);
    expect(out.evidence_flags).toEqual([
      { finding_id: 'f1', file: run.usage.file, line_start: run.usage.line_start, line_end: run.usage.line_end, match: true },
    ]);
    const db = openSession(engine, run.repo).db;
    expect(listFindings(db, run.id).map((f) => f.finding.id)).toEqual(['f1']);
    expect(findingsForRun(engine, run.id).map((row) => row.finding.id)).toEqual(['f1']);
    expect(listMarks(db, run.id)).toEqual([{ lens: 'api', usage_id: other!.id, reason: 'already in the target form', written_by: 'api' }]);
    const events = listEvents(db, run.id).map((e) => e.kind);
    expect(events).toContain('findings.submitted');
    expect(events).toContain('findings.normalised');
  });

  it('flags a snippet hash mismatch and still stores the finding', async () => {
    const run = await fullRun();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [finding(run.repoId, run.usage, { evidence: [{ repo_id: run.repoId, file: run.usage.file, line_start: run.usage.line_start, line_end: run.usage.line_end, snippet_hash: 'b'.repeat(64) }] })],
      out_of_scope: [],
    });
    expect(out.accepted).toBe(true);
    expect(out.evidence_flags[0]?.match).toBe(false);
    const stored = listFindings(openSession(engine, run.repo).db, run.id)[0]!;
    expect(stored.finding.evidence[0]?.snippet_hash).toBe('b'.repeat(64));
  });

  it('retries once, records lens.gap on the second invalid submit, and refuses a third', async () => {
    const run = await fullRun();
    const bad = { run_id: run.id, lens: 'api' as const, findings: [finding(run.repoId, run.usage, { concern: 'style' })], out_of_scope: [] };
    const first = await submitFindings(engine, bad);
    expect(first.accepted).toBe(false);
    expect(first.retry).toBe(true);
    expect(first.gap).toBe(false);
    expect(first.errors.length).toBeGreaterThan(0);
    expect(listFindings(openSession(engine, run.repo).db, run.id)).toEqual([]);
    const second = await submitFindings(engine, bad);
    expect(second.retry).toBe(false);
    expect(second.gap).toBe(true);
    expect(listFindings(openSession(engine, run.repo).db, run.id)).toEqual([]);
    expect(listEvents(openSession(engine, run.repo).db, run.id).some((e) => e.kind === 'lens.gap')).toBe(true);
    const third = await submitFindings(engine, bad).catch((err: unknown) => err);
    expect(third).toBeInstanceOf(InputError);
    expect((third as InputError).code).toBe('lens_closed');
  });

  it('rejects an out-of-scope entry outside the packet or with an empty reason, and counts it', async () => {
    const run = await fullRun();
    const outside = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [],
      out_of_scope: [{ usage_id: 'not-in-this-packet', reason: 'unused' }],
    });
    expect(outside.accepted).toBe(false);
    expect(outside.retry).toBe(true);
    expect(outside.errors.some((e) => e.path === 'out_of_scope.0.usage_id')).toBe(true);
    const empty = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [],
      out_of_scope: [{ usage_id: run.usage.id, reason: '   ' }],
    });
    expect(empty.gap).toBe(true);
    expect(empty.errors.some((e) => e.path === 'out_of_scope.0.reason' && e.message.includes('empty'))).toBe(true);
    expect(listMarks(openSession(engine, run.repo).db, run.id)).toEqual([]);
  });

  it('rejects a submission that both marks a usage and writes a finding on it, and stores nothing', async () => {
    const run = await fullRun();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [finding(run.repoId, run.usage, { id: 'both' })],
      out_of_scope: [{ usage_id: run.usage.id, reason: 'already migrated' }],
    });
    expect(out.accepted).toBe(false);
    expect(out.retry).toBe(true);
    expect(out.stored).toBe(0);
    expect(out.errors.some((e) => e.message.includes('both marked'))).toBe(true);
    const db = openSession(engine, run.repo).db;
    expect(listFindings(db, run.id)).toEqual([]);
    expect(listMarks(db, run.id)).toEqual([]);
  });

  it('rejects a usage marked out of scope twice, and stores nothing', async () => {
    const run = await fullRun();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [],
      out_of_scope: [
        { usage_id: run.usage.id, reason: 'already in the target form' },
        { usage_id: run.usage.id, reason: 'already in the target form' },
      ],
    });
    expect(out.accepted).toBe(false);
    expect(out.retry).toBe(true);
    expect(out.stored).toBe(0);
    expect(out.errors.some((e) => e.message.includes('more than once'))).toBe(true);
    expect(listFindings(openSession(engine, run.repo).db, run.id)).toEqual([]);
    expect(listMarks(openSession(engine, run.repo).db, run.id)).toEqual([]);
  });

  it('rejects a finding for the wrong lens, the wrong prompt, a duplicate id, no usage, or a usage outside the packet', async () => {
    const run = await fullRun();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [
        finding(run.repoId, run.usage, { id: 'wrong-lens', lens: 'verification' }),
        finding(run.repoId, run.usage, { id: 'wrong-prompt', prompt_version: 'v9' }),
        finding(run.repoId, run.usage, { id: 'same' }),
        finding(run.repoId, run.usage, { id: 'same' }),
        finding(run.repoId, run.usage, { id: 'no-usage', source: 'rule_pack', usage_ids: [] }),
        finding(run.repoId, run.usage, { id: 'outside', usage_ids: ['not-in-this-packet'] }),
      ],
      out_of_scope: [],
    });
    expect(out.accepted).toBe(false);
    expect(out.retry).toBe(true);
    expect(out.stored).toBe(0);
    const messages = out.errors.map((e) => `${e.path} ${e.message}`).join('\n');
    expect(messages).toMatch(/lens is verification/);
    expect(messages).toMatch(/prompt_version must be v1/);
    expect(messages).toMatch(/already used/);
    expect(messages).toMatch(/names a usage/);
    expect(messages).toMatch(/not in this lens packet/);
    expect(listFindings(openSession(engine, run.repo).db, run.id)).toEqual([]);
  });

  it('refuses a submission before that lens packet exists', async () => {
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    const id = scan.run!.run_id;
    await findUsages(engine, { run_id: id });
    await proposeScope(engine, { run_id: id });
    await setScope(engine, { run_id: id, answers: {} });
    const missing = await submitFindings(engine, {
      run_id: id,
      lens: 'api',
      findings: [],
      out_of_scope: [],
    }).catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(InputError);
    expect((missing as InputError).code).toBe('no_packet');
  });

  it('recomputes docs_status from the run docs', async () => {
    const run = await fullRun();
    const out = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [
        finding(run.repoId, run.usage, {
          id: 'cited',
          docs_status: 'verified',
          doc_refs: [{ library: 'next', version: '16', url: 'https://nextjs.org/docs/missing', doc_id: 'not-in-this-run' }],
        }),
      ],
      out_of_scope: [],
    });
    expect(out.accepted, JSON.stringify(out.errors)).toBe(true);
    expect(findingsForRun(engine, run.id)[0]?.finding.docs_status).toBe('unverified');
  });

  it('accepts the retry when the second submission is valid', async () => {
    const run = await fullRun();
    const bad = await submitFindings(engine, {
      run_id: run.id,
      lens: 'api',
      findings: [finding(run.repoId, run.usage, { source: 'agent_judgment', evidence: [], usage_ids: [] })],
      out_of_scope: [],
    });
    expect(bad.retry).toBe(true);
    const good = await submitFindings(engine, { run_id: run.id, lens: 'api', findings: [finding(run.repoId, run.usage)], out_of_scope: [] });
    expect(good.accepted, JSON.stringify(good.errors)).toBe(true);
    expect(listFindings(openSession(engine, run.repo).db, run.id)).toHaveLength(1);
  });
});
