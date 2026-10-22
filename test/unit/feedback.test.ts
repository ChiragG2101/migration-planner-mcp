// record_feedback (M9 task 6). Stored with the run, exported to
// <out>/eval/feedback/<run_id>-<n>.json, and a `missing` entry's file goes
// through SafePath, so `../`, an absolute path outside the repo or a symlink
// escape is rejected. scripts/feedback-to-case.ts only appends annotations.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeEngine,
  createEngine,
  emitPlan,
  findUsages,
  InputError,
  mergeFindings,
  PermissionError,
  proposeScope,
  recordFeedback,
  scanRepo,
  setScope,
  validatePlan,
  type Engine,
} from '../../src/core/index.js';
import { openSession } from '../../src/core/engine.js';
import { FeedbackExport } from '../../src/schema/feedback.js';
import { listEvents } from '../../src/store/events.js';
import { listFeedback } from '../../src/store/feedback.js';
import { appendAnnotation, toAnnotation, toSeededEntry, type Feedback } from '../../scripts/feedback-to-case.js';
import { copyFixture, runCli, symlink, tmpDir } from '../helpers.js';

let engine: Engine;
let out: string;
let repo: string;
let id: string;

beforeAll(async () => {
  out = tmpDir();
  engine = createEngine({ out });
  repo = copyFixture('next-clean');
  const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
  id = scan.run!.run_id;
  await findUsages(engine, { run_id: id });
  await proposeScope(engine, { run_id: id });
  await setScope(engine, { run_id: id, answers: {} });
  await mergeFindings(engine, { run_id: id });
  await validatePlan(engine, { run_id: id });
  await emitPlan(engine, { run_id: id });
});
afterAll(() => closeEngine(engine));

describe('record_feedback', () => {
  it('stores the entry with the run and exports an eval-case file under the output folder', async () => {
    const res = await recordFeedback(engine, { run_id: id, finding_id: 'engine-bump', stage_id: 'stage-bump', kind: 'severity_wrong', note: 'a patch bump, not high' });
    expect(res).toEqual({ run_id: id, n: 1, kind: 'severity_wrong', export_path: `eval/feedback/${id}-1.json` });
    const db = openSession(engine, repo).db;
    expect(listFeedback(db, id)).toMatchObject([{ n: 1, kind: 'severity_wrong', finding_id: 'engine-bump', stage_id: 'stage-bump', note: 'a patch bump, not high', export_path: res.export_path }]);
    expect(listEvents(db, id).some((e) => e.kind === 'feedback.recorded')).toBe(true);
    const exported = FeedbackExport.parse(JSON.parse(readFileSync(path.join(out, res.export_path), 'utf8')));
    expect(exported).toMatchObject({ run_id: id, n: 1, kind: 'severity_wrong', finding: { id: 'engine-bump', severity: 'high' }, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    // Nothing is written into the repo.
    expect(existsSync(path.join(repo, 'eval'))).toBe(false);
  });

  it('a missing entry keeps its repo-relative file and line, and numbers on', async () => {
    const res = await recordFeedback(engine, { run_id: id, kind: 'missing', note: 'this layout still uses the old API', file: './app/layout.tsx', line: 3 });
    expect(res.n).toBe(2);
    const exported = FeedbackExport.parse(JSON.parse(readFileSync(path.join(out, res.export_path), 'utf8')));
    expect(exported).toMatchObject({ kind: 'missing', file: 'app/layout.tsx', line: 3, finding: null });
  });

  it('rejects a missing entry whose file climbs out of the repo, and writes nothing', async () => {
    const before = listFeedback(openSession(engine, repo).db, id).length;
    for (const file of ['../outside.ts', '../../etc/passwd', '/etc/passwd', 'app/../../x.ts']) {
      const err = await recordFeedback(engine, { run_id: id, kind: 'missing', note: 'n', file, line: 1 }).catch((e: unknown) => e);
      expect(err, file).toBeInstanceOf(PermissionError);
      expect((err as PermissionError).code).toBe('outside_root');
    }
    expect(listFeedback(openSession(engine, repo).db, id)).toHaveLength(before);
    expect(existsSync(path.join(out, 'eval', 'feedback', `${id}-${before + 1}.json`))).toBe(false);
  });

  it('rejects a symlink that leads out of the repo', async () => {
    const outside = tmpDir();
    symlink(outside, path.join(repo, 'escape'));
    const err = await recordFeedback(engine, { run_id: id, kind: 'missing', note: 'n', file: 'escape/x.ts', line: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
  });

  it('refuses a file on another kind, an unknown finding or stage, and an empty note', async () => {
    await expect(recordFeedback(engine, { run_id: id, kind: 'wrong', note: 'n', file: 'app/page.tsx' })).rejects.toBeInstanceOf(InputError);
    await expect(recordFeedback(engine, { run_id: id, kind: 'missing', note: 'n', line: 3 })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('line needs a file') });
    await expect(recordFeedback(engine, { run_id: id, kind: 'wrong', note: 'n', finding_id: 'nope' })).rejects.toMatchObject({ code: 'unknown_finding' });
    await expect(recordFeedback(engine, { run_id: id, kind: 'bad_patch', note: 'n', stage_id: 'nope' })).rejects.toMatchObject({ code: 'unknown_stage' });
    await expect(recordFeedback(engine, { run_id: id, kind: 'other', note: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(recordFeedback(engine, { run_id: id, kind: 'other', note: 'n', command: 'rm -rf /' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the CLI feedback command records an entry for the same run', () => {
    const res = runCli(['feedback', repo, '--source', 'next', '--target', 'next@16.0.0', '--out', out, '--kind', 'other', '--note', 'from the CLI']);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { run_id: string; export_path: string };
    expect(parsed.run_id).toBe(id);
    expect(existsSync(path.join(out, parsed.export_path))).toBe(true);
  });
});

describe('scripts/feedback-to-case.ts', () => {
  const fb: Feedback = FeedbackExport.parse({
    format: 'migration-planner-feedback@1',
    run_id: 'run-1',
    n: 4,
    campaign_id: 'c',
    repo_id: 'r',
    pack: 'nextjs-upgrade@1',
    source: { name: 'next', version: '14.2.0' },
    target: { name: 'next', version: '16.0.0' },
    prompt_version: 'v1',
    kind: 'missing',
    note: 'cookies() in a helper',
    finding_id: null,
    stage_id: null,
    file: 'lib/session.ts',
    line: 7,
    finding: null,
    created_at: '2026-10-22T00:00:00.000Z',
  });

  it('appends an annotation and keeps every existing entry as it was', () => {
    const existing = [{ finding: 'f1', reason: 'PR missed it', reviewer: 'maintainer', date: '2026-10-01' }];
    const entry = toAnnotation(fb, 'maintainer', '2026-10-22');
    const next = appendAnnotation(existing, entry);
    expect(next.entries[0]).toEqual(existing[0]);
    expect(next.entries).toHaveLength(2);
    expect(next.entries[1]).toEqual({ finding: 'lib/session.ts:7', reason: 'missing: cookies() in a helper (feedback run-1-4)', reviewer: 'maintainer', date: '2026-10-22' });
    expect(() => appendAnnotation(next.entries, entry)).toThrow(/already has this entry/);
    expect(appendAnnotation(undefined, entry).entries).toEqual([entry]);
  });

  it('needs a reviewer: an annotation is never automatic', () => {
    expect(() => toAnnotation(fb, '', '2026-10-22')).toThrow(/reviewer/);
  });

  it('maps missing and wrong feedback to seeded ground-truth entries, and refuses the rest', () => {
    expect(toSeededEntry(fb)).toMatchObject({ file: 'lib/session.ts', line: 7, expect: 'change' });
    const wrong = { ...fb, kind: 'wrong' as const, file: null, line: null, finding: { id: 'f', severity: 'high', rule_id: 'next/x', evidence: [{ file: 'app/a.ts', line_start: 2, line_end: 2 }] } };
    expect(toSeededEntry(wrong)).toMatchObject({ file: 'app/a.ts', line: 2, expect: 'no_finding', rule_id: 'next/x' });
    expect(() => toSeededEntry({ ...fb, kind: 'bad_patch' })).toThrow(/does not map/);
  });
});
