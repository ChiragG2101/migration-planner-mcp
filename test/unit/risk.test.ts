// The risk signals. Severity only moves up, and a codemod never lowers it.
// The seeded case runs assess_risk on next-tricky, which is what the plan requires.
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntrypoint, isTestFile, riskOf, type RiskContext } from '../../src/analysis/risk.js';
import { assessRisk, closeEngine, createEngine, findUsages, scanRepo, type Engine } from '../../src/core/index.js';
import type { ComposedRule } from '../../src/rules/compose.js';
import type { ReviewedRule, Severity } from '../../src/schema/knowledge.js';
import type { Match } from '../../src/schema/match.js';
import type { Usage } from '../../src/schema/usage.js';
import { repoRoot, tmpDir } from '../helpers.js';

const ctx: RiskContext = { fanIn: 0, tested: false, entrypoint: false };

function usage(over: Partial<Usage> = {}): Usage {
  return {
    id: 'u1',
    repo_id: 'repo',
    file: 'app/page.tsx',
    line_start: 4,
    line_end: 4,
    snippet_hash: 'h',
    kind: 'request_api',
    symbol: 'next/headers.cookies',
    module: 'next/headers',
    match_kind: 'call',
    context: 'cookies()',
    via: [],
    confidence: 'exact',
    labels: [],
    ...over,
  };
}

function rule(over: Partial<ReviewedRule> & { match: Match; event?: ReviewedRule['event']; default_severity?: Severity }): ComposedRule {
  const reviewed: ReviewedRule = {
    id: 'next/async-request-apis',
    title: 'Request APIs are async',
    event: 'changed_behavior',
    status: 'reviewed',
    source: 'https://nextjs.org/docs/app/guides/upgrading/version-15#async-request-apis',
    concern: 'A synchronous call throws at runtime.',
    default_severity: 'medium',
    mapping: { from: 'cookies()', to: 'await cookies()' },
    no_equivalent: false,
    notes: '',
    verify_hint: 'Load a page that reads a cookie.',
    rollback_hint: 'Return to the previous release.',
    doc_topics: ['cookies'],
    ...over,
  };
  return {
    rule: reviewed,
    library: 'npm/next',
    defined_in: '15',
    events: [],
    in_range: [],
    necessity: reviewed.event === 'deprecated' ? 'deprecated' : 'breaks',
    lands_on: 'target',
  };
}

describe('risk', () => {
  it('raises an async request API used through a helper, a caching usage and a peer conflict', () => {
    const helper = riskOf(usage({ via: [{ file: 'server/session.ts', line: 4, symbol: 'session' }] }), [], ctx);
    expect(helper.suggested_severity).toBe('high');
    expect(helper.signals.find((s) => s.name === 'sync_to_async')?.detail).toContain('helper');
    expect(helper.unmapped).toBe(true);

    const cache = riskOf(usage({ kind: 'cache_api', symbol: 'next/cache.revalidateTag', module: 'next/cache' }), [], ctx);
    expect(cache.suggested_severity).toBe('high');
    expect(cache.signals.some((s) => s.name === 'behavior')).toBe(true);

    const peer = riskOf(
      usage({
        kind: 'peer_dependency',
        symbol: 'legacy-modal@1.0.0 peer react@^16.8.0 || ^17.0.0 || ^18.0.0',
        module: 'react',
        match_kind: 'dependency',
        file: 'package-lock.json',
        labels: ['peer_conflict'],
      }),
      [],
      ctx,
    );
    expect(peer.suggested_severity).toBe('blocker');
    expect(peer.signals.find((s) => s.name === 'peer_conflict')?.detail).toContain('no version');
  });

  it('starts from the rule default and never lets a codemod lower it', () => {
    const match: Match = { kind: 'call', module: 'next/headers', name: 'cookies' };
    const covered = riskOf(usage(), [rule({ match, default_severity: 'high', codemod: 'next-codemod:next-async-request-api' })], ctx);
    expect(covered.suggested_severity).toBe('high');
    expect(covered.rule_id).toBe('next/async-request-apis');
    expect(covered.signals.find((s) => s.name === 'codemod')?.detail).toContain('verify step');

    const low = riskOf(usage({ kind: 'config_key', symbol: 'images', module: 'next.config', match_kind: 'config_key' }), [
      rule({
        id: 'next/images',
        event: 'deprecated',
        default_severity: 'low',
        match: { kind: 'config_key', file_kind: 'next.config', path: 'images' },
        codemod: 'next-codemod:next-image-experimental',
      }),
    ], ctx);
    expect(low.suggested_severity).toBe('low');
    expect(low.necessity).toBe('deprecated');
  });

  it('raises no_equivalent and a behaviour-only rule, and flags a usage no rule binds', () => {
    const none = riskOf(
      usage({ kind: 'config_key', symbol: 'images', module: 'next.config', match_kind: 'config_key' }),
      [rule({ id: 'next/images', event: 'removed', default_severity: 'low', no_equivalent: true, match: { kind: 'config_key', file_kind: 'next.config', path: 'images' } })],
      ctx,
    );
    expect(none.suggested_severity).toBe('high');
    expect(none.signals.some((s) => s.name === 'no_equivalent')).toBe(true);

    const fetchCall = riskOf(usage({ kind: 'fetch_call', symbol: 'fetch', module: null, match_kind: 'call' }), [], ctx);
    expect(fetchCall.suggested_severity).toBe('high');
    expect(fetchCall.signals.some((s) => s.name === 'behavior')).toBe(true);

    const behavior = riskOf(usage({ kind: 'config_key', symbol: 'staleTimes', module: 'next.config', match_kind: 'config_key' }), [
      rule({ id: 'next/stale', event: 'changed_default', default_severity: 'low', match: { kind: 'config_key', file_kind: 'next.config', path: 'staleTimes' } }),
    ], ctx);
    expect(behavior.suggested_severity).toBe('high');

    const unmapped = riskOf(usage({ kind: 'dependency', symbol: 'typescript', module: 'typescript', match_kind: 'dependency' }), [], ctx);
    expect(unmapped.unmapped).toBe(true);
    expect(unmapped.suggested_severity).toBe('info');
    expect(unmapped.rule_id).toBeNull();
  });

  it('records fan-in, entrypoints and tests, and raises a widely imported file', () => {
    const wide = riskOf(usage({ kind: 'dependency', symbol: 'next', module: 'next', match_kind: 'dependency' }), [], {
      fanIn: 5,
      tested: true,
      entrypoint: true,
    });
    expect(wide.suggested_severity).toBe('medium');
    expect(wide.signals.find((s) => s.name === 'fan_in')?.detail).toBe('5 files import this file');
    expect(wide.signals.find((s) => s.name === 'tests')?.detail).toContain('a test file');
    expect(wide.signals.some((s) => s.name === 'entrypoint')).toBe(true);
    expect(isEntrypoint('app/api/feed/route.ts')).toBe(true);
    expect(isEntrypoint('src/middleware.ts')).toBe(true);
    expect(isEntrypoint('server/session.ts')).toBe(false);
    expect(isTestFile('__tests__/page.test.tsx')).toBe(true);
    expect(isTestFile('app/page.tsx')).toBe(false);
  });
});

const RANK: readonly string[] = ['info', 'low', 'medium', 'high', 'blocker'];

describe('risk on next-tricky', () => {
  let engine: Engine;

  beforeAll(() => {
    engine = createEngine({ out: tmpDir() });
  });
  afterAll(() => closeEngine(engine));

  it('flags every planted change at medium or above, with a reason for each signal', async () => {
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
    expect(scan.status).toBe('ok');
    const id = scan.run!.run_id;
    await findUsages(engine, { run_id: id });
    const { risks } = await assessRisk(engine, { run_id: id });

    const truth = JSON.parse(readFileSync(path.join(repo, 'ground_truth.json'), 'utf8')) as {
      entries: { id: string; file: string; line: number; kind: string; expect: string; indirect?: boolean }[];
    };
    const below: string[] = [];
    for (const entry of truth.entries.filter((e) => e.expect === 'change')) {
      const hit = risks.find((r) => r.file === entry.file && r.kind === entry.kind && r.line === entry.line);
      if (!hit || RANK.indexOf(hit.suggested_severity) < RANK.indexOf('medium') || hit.signals.some((s) => s.detail.trim() === '')) {
        below.push(`${entry.id} ${hit?.suggested_severity ?? 'missing'}`);
      }
    }
    expect(below).toEqual([]);

    const helper = risks.find((r) => r.file === 'app/dashboard/page.tsx' && r.kind === 'request_api');
    const caching = risks.filter((r) => r.kind === 'fetch_call' || r.kind === 'cache_api');
    const peers = risks.filter((r) => r.kind === 'peer_dependency' && r.signals.some((s) => s.name === 'peer_conflict'));
    expect(helper?.signals.find((s) => s.name === 'sync_to_async')?.detail).toContain('helper');
    for (const r of [helper, ...caching, ...peers]) {
      expect(r, r?.kind).toBeTruthy();
      expect(RANK.indexOf(r!.suggested_severity)).toBeGreaterThanOrEqual(RANK.indexOf('high'));
    }
    expect(caching.length).toBeGreaterThan(0);
    expect(peers.length).toBeGreaterThan(0);
  });
});
