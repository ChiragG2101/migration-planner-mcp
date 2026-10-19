// Finding schema: every enum, the codemod allowlist, repo_id and agent_judgment (INV-22, INV-57).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Concern, Finding, FindingLens, FindingSource, StepKind, parseFinding, type FindingContext } from '../../src/schema/finding.js';
import { Plan } from '../../src/schema/plan.js';
import { Severity } from '../../src/schema/knowledge.js';
import { tmpDir } from '../helpers.js';
import { inMemoryClient } from '../mcp.js';

const HASH = 'a'.repeat(64);
const ctx: FindingContext = {
  repoId: 'repo-1',
  codemodsFor: (id) => (id === 'next/cachelife-and-cachetag' ? ['next-codemod:remove-unstable-prefix'] : undefined),
};

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    repo_id: 'repo-1',
    lens: 'api',
    concern: 'api_change',
    severity: 'medium',
    evidence: [{ repo_id: 'repo-1', file: 'lib/cache.ts', line_start: 1, line_end: 2, snippet_hash: HASH }],
    doc_refs: [],
    reasoning: 'The call is still in the old form.',
    action: 'Await the call.',
    step_kind: 'manual',
    verify: 'Load the page.',
    confidence: 0.5,
    source: 'rule_pack',
    usage_ids: ['u1'],
    docs_status: 'verified',
    prompt_version: 'v1',
    ...over,
  };
}

describe('finding schema', () => {
  it('accepts every enum value and both ends of confidence', () => {
    for (const concern of Concern.options) expect(parseFinding(base({ concern }), ctx).ok).toBe(true);
    for (const severity of Severity.options) expect(parseFinding(base({ severity }), ctx).ok).toBe(true);
    for (const source of FindingSource.options) {
      const evidence = source === 'agent_judgment' ? base().evidence : base().evidence;
      expect(parseFinding(base({ source, evidence, usage_ids: source === 'agent_judgment' ? [] : ['u1'] }), ctx).ok).toBe(true);
    }
    for (const lens of FindingLens.options) expect(parseFinding(base({ lens }), ctx).ok).toBe(true);
    expect(parseFinding(base({ step_kind: 'manual' }), ctx).ok).toBe(true);
    expect(parseFinding(base({ confidence: 0 }), ctx).ok).toBe(true);
    expect(parseFinding(base({ confidence: 1 }), ctx).ok).toBe(true);
    for (const step of StepKind.options) {
      const extra = step === 'codemod' ? { step_kind: step, codemod: 'next-codemod:remove-unstable-prefix', rule_id: 'next/cachelife-and-cachetag' } : { step_kind: step };
      expect(parseFinding(base(extra), ctx).ok).toBe(true);
    }
  });

  it('rejects an unknown enum, a confidence outside 0 to 1, and a manual step that names a codemod', () => {
    expect(parseFinding(base({ concern: 'style' }), ctx).ok).toBe(false);
    expect(parseFinding(base({ severity: 'urgent' }), ctx).ok).toBe(false);
    expect(parseFinding(base({ source: 'guess' }), ctx).ok).toBe(false);
    expect(parseFinding(base({ lens: 'security' }), ctx).ok).toBe(false);
    expect(parseFinding(base({ step_kind: 'auto' }), ctx).ok).toBe(false);
    for (const confidence of [-0.01, 1.01]) {
      const result = parseFinding(base({ confidence }), ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.path === 'confidence')).toBe(true);
    }
    const manual = parseFinding(base({ codemod: 'next-codemod:remove-unstable-prefix' }), ctx);
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.errors.some((e) => e.path === 'codemod')).toBe(true);
  });

  it('rejects a codemod the rule library does not list, and a codemod step with no usages', () => {
    const foreign = parseFinding(
      base({ step_kind: 'codemod', codemod: 'next-codemod:upgrade', rule_id: 'next/cachelife-and-cachetag' }),
      ctx,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errors.map((e) => e.message).join(' ')).toMatch(/not listed/);
    const missing = parseFinding(
      base({ step_kind: 'codemod', codemod: 'next-codemod:remove-unstable-prefix', rule_id: 'next/cachelife-and-cachetag', usage_ids: [] }),
      ctx,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.some((e) => e.path === 'usage_ids')).toBe(true);
    const unknown = parseFinding(base({ step_kind: 'codemod', codemod: 'next-codemod:upgrade', rule_id: 'next/not-a-rule' }), ctx);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.some((e) => e.path === 'rule_id')).toBe(true);
  });

  it('rejects evidence whose repo_id differs, and a finding for another repo', () => {
    const evidence = parseFinding(base({ evidence: [{ repo_id: 'other', file: 'a.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }), ctx);
    expect(evidence.ok).toBe(false);
    if (!evidence.ok) expect(evidence.errors.some((e) => e.path === 'evidence.0.repo_id')).toBe(true);
    const finding = parseFinding(base({ repo_id: 'other', evidence: [{ repo_id: 'other', file: 'a.ts', line_start: 1, line_end: 1, snippet_hash: HASH }] }), ctx);
    expect(finding.ok).toBe(false);
    if (!finding.ok) expect(finding.errors.some((e) => e.path === 'repo_id' && e.message.includes('repo-1'))).toBe(true);
  });

  it('rejects a line range that runs backwards, and a codemod step with no rule', () => {
    const lines = parseFinding(base({ evidence: [{ repo_id: 'repo-1', file: 'a.ts', line_start: 4, line_end: 2, snippet_hash: HASH }] }), ctx);
    expect(lines.ok).toBe(false);
    if (!lines.ok) expect(lines.errors.some((e) => e.path === 'evidence.0.line_end' && e.message.includes('before'))).toBe(true);
    const rule = parseFinding(base({ step_kind: 'codemod', codemod: 'next-codemod:remove-unstable-prefix' }), ctx);
    expect(rule.ok).toBe(false);
    if (!rule.ok) expect(rule.errors.some((e) => e.path === 'rule_id' && e.message.includes('names the rule'))).toBe(true);
  });

  it('rejects agent_judgment with no evidence', () => {
    const result = parseFinding(base({ source: 'agent_judgment', evidence: [], usage_ids: [] }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.message).join(' ')).toMatch(/agent_judgment requires evidence/);
  });

  it('serves schema://finding and schema://plan as JSON Schema', async () => {
    const mcp = await inMemoryClient({ out: tmpDir() });
    try {
      const finding = await mcp.client.readResource({ uri: 'schema://finding' });
      const plan = await mcp.client.readResource({ uri: 'schema://plan' });
      const findingText = finding.contents[0] && 'text' in finding.contents[0] ? finding.contents[0].text : '';
      const planText = plan.contents[0] && 'text' in plan.contents[0] ? plan.contents[0].text : '';
      expect(findingText).toContain('api_change');
      expect(findingText).toContain('agent_judgment');
      expect(planText).toContain('out_of_scope');
      expect(JSON.parse(findingText!)).toEqual(z.toJSONSchema(Finding));
      expect(JSON.parse(planText!)).toEqual(z.toJSONSchema(Plan));
    } finally {
      await mcp.close();
    }
  });
});
