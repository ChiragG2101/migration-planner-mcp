// M9 outputs stay in the output folder (C3, INV-1). After a full L0 emit and a
// feedback entry, every file the engine wrote is under <out>/<run_id>/ (the
// plan, the checklists, run_report.md) or <out>/eval/feedback/ (the export),
// besides the store, and the target repo's hash is unchanged.
import { cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeEngine, createEngine, emitPlan, findUsages, mergeFindings, proposeScope, recordFeedback, scanRepo, setScope, validatePlan } from '../../src/core/index.js';
import { repoHash } from '../../scripts/repo-hash.js';
import { repoRoot, tmpDir } from '../helpers.js';

function filesUnder(root: string, rel = ''): string[] {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((d) => {
    const r = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? filesUnder(root, r) : [r];
  });
}

describe('emit outputs', () => {
  it('writes plans, checklists, reports and feedback only under the output folder, and the repo hash is unchanged', async () => {
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const before = repoHash(repo);
    const out = tmpDir();
    const engine = createEngine({ out });
    let id: string;
    try {
      const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      id = scan.run!.run_id;
      await findUsages(engine, { run_id: id });
      await proposeScope(engine, { run_id: id });
      await setScope(engine, { run_id: id, answers: {} });
      await mergeFindings(engine, { run_id: id });
      await validatePlan(engine, { run_id: id });
      const emitted = await emitPlan(engine, { run_id: id });
      await recordFeedback(engine, { run_id: id, kind: 'other', note: 'n' });
      for (const p of [emitted.plan_json, emitted.plan_md, emitted.run_report, ...emitted.checklists]) expect(p.startsWith(`${id}/`)).toBe(true);
    } finally {
      closeEngine(engine);
    }
    const written = filesUnder(out).filter((f) => !f.startsWith('store.sqlite'));
    expect(written.length).toBeGreaterThan(3);
    for (const f of written) expect(f.startsWith(`${id}/`) || f.startsWith('eval/feedback/'), f).toBe(true);
    expect(written).toContain(`${id}/run_report.md`);
    expect(written.some((f) => /^[^/]+\/stages\/\d+\/CHECKLIST\.md$/.test(f))).toBe(true);
    expect(repoHash(repo)).toBe(before);
  });
});
