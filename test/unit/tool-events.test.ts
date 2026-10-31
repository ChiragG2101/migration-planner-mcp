// The event spine: every tool call writes tool.start and tool.end, or
// tool.error carrying the PermissionError details, under the run's ID.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, findUsages, InputError, PermissionError, scanRepo, type Engine } from '../../src/core/index.js';
import { openSession, runTool } from '../../src/core/engine.js';
import { listEvents } from '../../src/store/events.js';
import { getRun } from '../../src/store/runs.js';
import { copyFixture, tmpDir } from '../helpers.js';

let engine: Engine;
let repo: string;

beforeAll(() => {
  engine = createEngine({ out: tmpDir() });
  repo = copyFixture('next-basic');
});
afterAll(() => closeEngine(engine));

const db = (): ReturnType<typeof openSession>['db'] => openSession(engine, repo).db;

describe('tool events', () => {
  it('a scan writes start, run, result and end, all under the run, with campaign and repo IDs on the run', async () => {
    const res = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } });
    const events = listEvents(db(), res.run!.run_id);
    expect(events.map((e) => [e.step, e.kind])).toEqual([
      ['scan_repo', 'tool.start'],
      ['scan_repo', 'ingest.run'],
      ['scan_repo', 'scan.result'],
      ['scan_repo', 'repo.hash'],
      ['scan_repo', 'tool.end'],
    ]);
    expect(JSON.parse(events[2]!.payload_json)).toEqual(res.scan);
    expect(getRun(db(), res.run!.run_id)).toMatchObject({
      campaign_id: res.run!.campaign_id,
      repo_id: res.run!.repo_id,
      status: 'scanned',
    });
    const files = db().prepare('SELECT COUNT(*) AS n FROM files WHERE run_id = ?').get(res.run!.run_id) as { n: number };
    expect(files.n).toBe(res.scan!.files.read);
  });

  it('find_usages writes start, usages.result and end under the run, and a refused cursor writes tool.error', async () => {
    const res = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } });
    const runId = res.run!.run_id;
    const before = listEvents(db(), runId).length;
    await findUsages(engine, { run_id: runId });
    expect(listEvents(db(), runId).slice(before).map((e) => [e.step, e.kind])).toEqual([
      ['find_usages', 'tool.start'],
      ['find_usages', 'usages.result'],
      ['find_usages', 'tool.end'],
    ]);
    await expect(findUsages(engine, { run_id: runId, cursor: 'bad' })).rejects.toThrow(InputError);
    const last = listEvents(db(), runId).at(-1)!;
    expect([last.kind, (JSON.parse(last.payload_json) as { code: string }).code]).toEqual(['tool.error', 'bad_cursor']);
  });

  it('a question writes start, question and end with no run ID', async () => {
    const before = listEvents(db()).length;
    const res = await scanRepo(engine, { repo_path: repo, target: { name: 'next', version: '15.1.0' } });
    expect(res.status).toBe('question');
    const added = listEvents(db()).slice(before);
    expect(added.map((e) => [e.kind, e.run_id])).toEqual([
      ['tool.start', null],
      ['ingest.question', null],
      ['tool.end', null],
    ]);
  });

  it('a PermissionError inside a tool is recorded as tool.error with its code and message', async () => {
    const before = listEvents(db()).length;
    const session = openSession(engine, repo);
    await expect(
      runTool(engine, session, 'probe', { path: '.env' }, () => {
        throw new PermissionError('denied', 'denied by the deny list: .env', { path: '.env' });
      }),
    ).rejects.toThrow(PermissionError);
    const added = listEvents(db()).slice(before);
    expect(added.map((e) => e.kind)).toEqual(['tool.start', 'tool.error']);
    expect(JSON.parse(added[1]!.payload_json)).toEqual({
      name: 'PermissionError',
      code: 'denied',
      message: 'denied by the deny list: .env',
      details: { path: '.env' },
    });
  });

  it('the store lives in the output folder, outside the repo', () => {
    const session = openSession(engine, repo);
    expect(session.dbPath.startsWith(session.outDir + path.sep)).toBe(true);
    expect(session.dbPath.startsWith(repo + path.sep)).toBe(false);
  });
});
