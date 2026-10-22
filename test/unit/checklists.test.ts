// Per-stage checklists (M9 task 3). One CHECKLIST.md per stage, codemods
// before manual steps, then the pack's checks hint; written by the normal L0
// emit only under <out>/<run_id>/stages/<n>/.
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, emitPlan, findUsages, mergeFindings, proposeScope, scanRepo, setScope, validatePlan, type Engine } from '../../src/core/index.js';
import { checklistPath, renderChecklist } from '../../src/pipeline/checklists.js';
import type { Finding } from '../../src/schema/finding.js';
import type { Stage } from '../../src/schema/plan.js';
import { repoRoot, tmpDir } from '../helpers.js';

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    repo_id: 'r',
    lens: 'api',
    concern: 'api_change',
    severity: 'medium',
    evidence: [{ repo_id: 'r', file: `app/${id}.ts`, line_start: 4, line_end: 4, snippet_hash: 'a'.repeat(64) }],
    doc_refs: [],
    reasoning: 'r',
    action: `Do ${id}.`,
    step_kind: 'manual',
    verify: `Check ${id}.`,
    rollback: `Undo ${id}.`,
    confidence: 0.9,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

const stage: Stage = { id: 'stage-1', order: 2, title: 'Request APIs', finding_ids: ['manual-a', 'cm', 'manual-b'], depends_on: ['stage-0'] };
const findings = [
  finding('manual-a'),
  finding('cm', { step_kind: 'codemod', codemod: 'next-codemod:next-async-request-api', rule_id: 'next/async-cookies', usage_ids: ['u1'] }),
  finding('manual-b', { docs_status: 'unverified', rollback: undefined }),
];

describe('renderChecklist', () => {
  const md = renderChecklist(stage, findings, 'npm test && npm run build', new Map([['manual-a', 'needs human decision']]));

  it('lists the codemods before the manual steps, then the checks hint', () => {
    const codemods = md.indexOf('## Codemods');
    const manual = md.indexOf('## Manual steps');
    const checks = md.indexOf('## Checks');
    expect(codemods).toBeGreaterThan(0);
    expect(manual).toBeGreaterThan(codemods);
    expect(checks).toBeGreaterThan(manual);
    expect(md.indexOf('next-codemod:next-async-request-api')).toBeLessThan(manual);
    expect(md.slice(checks)).toContain('npm test && npm run build');
  });

  it("gives each manual finding's action, verify and rollback, with its routing and docs marks", () => {
    const manual = md.slice(md.indexOf('## Manual steps'), md.indexOf('## Checks'));
    expect(manual).toContain('**manual-a** (medium) — `app/manual-a.ts:4` _(needs human decision)_');
    expect(manual).toContain('  - Action: Do manual-a.');
    expect(manual).toContain('  - Verify: Check manual-a.');
    expect(manual).toContain('  - Rollback: Undo manual-a.');
    expect(manual).toContain('**manual-b** (medium) — `app/manual-b.ts:4` _(docs unverified)_');
    expect(manual).not.toContain('Rollback: Undo manual-b.');
    expect(manual).not.toContain('**cm**');
  });

  it('is numbered by the stage position and lives under stages/<n>/', () => {
    expect(md.startsWith('# Stage 3: Request APIs')).toBe(true);
    expect(checklistPath('run-1', stage)).toBe('run-1/stages/3/CHECKLIST.md');
  });
});

describe('checklists at emit', () => {
  let engine: Engine;
  let out: string;
  beforeAll(() => {
    out = tmpDir();
    engine = createEngine({ out });
  });
  afterAll(() => closeEngine(engine));

  it('writes one checklist per stage, only under <out>/<run_id>/stages/', async () => {
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    const id = scan.run!.run_id;
    await findUsages(engine, { run_id: id });
    await proposeScope(engine, { run_id: id });
    await setScope(engine, { run_id: id, answers: {} });
    const merged = await mergeFindings(engine, { run_id: id });
    await validatePlan(engine, { run_id: id });
    const emitted = await emitPlan(engine, { run_id: id });

    expect(emitted.checklists).toHaveLength(merged.plan.stages.length);
    expect(readdirSync(path.join(out, id, 'stages')).sort()).toEqual(merged.plan.stages.map((s) => String(s.order + 1)).sort());
    for (const rel of emitted.checklists) {
      expect(rel.startsWith(`${id}/stages/`)).toBe(true);
      expect(rel.endsWith('/CHECKLIST.md')).toBe(true);
      expect(readFileSync(path.join(out, rel), 'utf8')).toContain('## Checks');
    }
    // Nothing lands in the repo.
    expect(existsSync(path.join(repo, 'stages'))).toBe(false);
    expect(existsSync(path.join(repo, id))).toBe(false);
  });
});
