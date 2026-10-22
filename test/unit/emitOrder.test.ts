// MIGRATION_PLAN.md section order (M9 task 2). A golden-file test of a mixed
// plan, with and without L1 results: Review first, Unresolved, Needs human
// decision, the per-stage summary, the stage details, then the footer. The
// needs-human section is present only when non-empty, and "docs unverified"
// findings carry the badge wherever routing puts them.
import { describe, expect, it } from 'vitest';
import { renderPlanMarkdown } from '../../src/pipeline/emit.js';
import { routePlan, type StageVerify } from '../../src/pipeline/routing.js';
import type { Finding } from '../../src/schema/finding.js';
import type { Plan } from '../../src/schema/plan.js';

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    repo_id: 'r',
    lens: 'api',
    concern: 'api_change',
    severity: 'medium',
    evidence: [{ repo_id: 'r', file: `app/${id}.ts`, line_start: 2, line_end: 2, snippet_hash: 'a'.repeat(64) }],
    doc_refs: [],
    reasoning: 'r',
    action: `Fix ${id}.`,
    step_kind: 'manual',
    verify: 'Run the tests.',
    rollback: 'Revert the edit.',
    confidence: 0.9,
    source: 'rule_pack',
    usage_ids: [],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

const mixed: Plan = {
  run_id: 'run',
  campaign_id: 'c',
  repo_id: 'r',
  pack: 'nextjs-upgrade@1.0.0',
  prompt_version: 'v1',
  stages: [
    { id: 'stage-prep', order: 0, title: 'Prep on the old version', finding_ids: ['judged', 'unsure', 'plain'], depends_on: [] },
    { id: 'stage-bump', order: 1, title: 'Bump next', finding_ids: ['engine-bump', 'codemod'], depends_on: ['stage-prep'] },
  ],
  findings: [
    finding('judged', { severity: 'high', source: 'agent_judgment', confidence: 0.95, docs_status: 'unverified' }),
    finding('unsure', { confidence: 0.4, docs_status: 'unverified' }),
    finding('plain'),
    finding('engine-bump', { severity: 'high', concern: 'dependency', confidence: 1 }),
    finding('codemod', { step_kind: 'codemod', codemod: 'next-codemod:next-async-request-api', rule_id: 'next/async-cookies', usage_ids: ['u1'] }),
  ],
  out_of_scope: [],
  unresolved: [{ finding_id: 'plain', gate: 'g1_evidence', reason: 'the snippet at app/plain.ts:2 no longer matches' }],
};

const meta = { packVersion: '1.0.0', status: 'capped' as const, gates: ['g1_evidence', 'g2_coverage'], engineVersion: '0.0.0', repoHash: { before: 'f'.repeat(64), after: 'f'.repeat(64) } };
const headings = (md: string): string[] => md.split('\n').filter((l) => l.startsWith('## ') || l === '---').map((l) => l.replace(/ \(\d+\)$/, ''));

describe('MIGRATION_PLAN.md order', () => {
  it('a mixed plan without L1 results', async () => {
    const routing = routePlan({ plan: mixed, threshold: 0.6, usages: [], targetRules: [], runRules: [] });
    const md = renderPlanMarkdown(mixed, { ...meta, routing, thresholdSource: 'default' });
    expect(headings(md)).toEqual(['## Review first', '## Unresolved', '## Needs human decision', '## Summary', '## Stages', '---']);
    // The badge follows the finding into Review first and Needs human decision.
    const review = md.slice(md.indexOf('## Review first'), md.indexOf('## Unresolved'));
    expect(review).toContain('#### judged — HIGH (api_change) _docs unverified_');
    expect(md.slice(md.indexOf('## Needs human decision'))).toContain('#### unsure — MEDIUM (api_change) _docs unverified_');
    expect(md).not.toContain('Verify: ');
    await expect(md).toMatchFileSnapshot('../fixtures/emit/mixed-l0.md');
  });

  it('a mixed plan with L1 results: unresolved stages, gate 7 holds and the per-stage decision', async () => {
    const verify: StageVerify[] = [
      { stage_id: 'stage-prep', decision: 'kept', attempts: 2, held_for_review: [] },
      { stage_id: 'stage-bump', decision: 'unresolved', attempts: 3, held_for_review: ['fewer_test_cases in app/a.test.ts: 3 -> 2'] },
    ];
    const routing = routePlan({ plan: mixed, threshold: 0.6, usages: [], targetRules: [], runRules: [], verify });
    const md = renderPlanMarkdown(mixed, { ...meta, routing, thresholdSource: 'default', verify });
    expect(headings(md)).toEqual(['## Review first', '## Unresolved', '## Needs human decision', '## Summary', '## Stages', '---']);
    expect(md).toContain('Verify: kept after 2 attempts.');
    expect(md).toContain('Verify: unresolved after 3 attempts.');
    expect(md).toContain('**verify** (stage 2. Bump next): rejected on all 3 attempts');
    expect(md).toContain('gate 7 held the patch for review: fewer_test_cases in app/a.test.ts');
    await expect(md).toMatchFileSnapshot('../fixtures/emit/mixed-l1.md');
  });

  it('leaves out Needs human decision and Review first when they are empty', () => {
    const calm: Plan = { ...mixed, findings: mixed.findings.map((f) => ({ ...f, confidence: 0.9, source: 'rule_pack' as const })), unresolved: [] };
    const routing = routePlan({ plan: calm, threshold: 0.6, usages: [], targetRules: [], runRules: [] });
    const md = renderPlanMarkdown(calm, { ...meta, routing });
    expect(headings(md)).toEqual(['## Summary', '## Stages', '---']);
  });

  it('the footer names the pack, prompt and gate versions, the threshold and the repo-untouched line', () => {
    const routing = routePlan({ plan: mixed, threshold: 0.7, usages: [], targetRules: [], runRules: [] });
    const md = renderPlanMarkdown(mixed, { ...meta, routing, thresholdSource: 'flag' });
    const footer = md.slice(md.lastIndexOf('---'));
    expect(footer).toContain('Pack `nextjs-upgrade@1.0.0` version 1.0.0, prompt v1, gates g1_evidence, g2_coverage (engine 0.0.0), confidence threshold 0.7 (flag).');
    expect(footer).toContain('The target repo was not modified by this plan (repo hash ffffffffffff before and after).');
    const moved = renderPlanMarkdown(mixed, { ...meta, routing, repoHash: { before: 'a'.repeat(64), after: 'b'.repeat(64) } });
    expect(moved.slice(moved.lastIndexOf('---'))).toContain('its files changed between the scan and this emit');
  });
});
