// run_report.md (M9 task 4). The report is a pure function of the run's event
// rows: it is rebuilt here from two fixture event logs, one L0 and one L1,
// whose every number is chosen to be recognisable, and the report emit writes
// is byte-equal to one rebuilt from the store after the engine has closed.
import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeEngine, createEngine, emitPlan, findUsages, mergeFindings, proposeScope, scanRepo, setScope, validatePlan } from '../../src/core/index.js';
import { buildRunReport, treeHash, type ReportEvent } from '../../src/pipeline/report.js';
import { openDb } from '../../src/store/db.js';
import { listEvents } from '../../src/store/events.js';
import { repoRoot, tmpDir } from '../helpers.js';

let clock = Date.parse('2026-10-22T10:00:00.000Z');
function ev(kind: string, payload: unknown, step = 'x', tokens?: [number, number]): ReportEvent {
  clock += 1000;
  return { ts: new Date(clock).toISOString(), step, kind, payload_json: JSON.stringify(payload), tokens_in: tokens?.[0] ?? null, tokens_out: tokens?.[1] ?? null };
}

function l0Log(): ReportEvent[] {
  clock = Date.parse('2026-10-22T10:00:00.000Z');
  return [
    ev('tool.start', { input: { repo_path: '/w/app', source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } } }, 'scan_repo'),
    ev('ingest.run', { run: { run_id: 'run-a', campaign_id: 'camp-7', repo_id: 'repo-9' }, versions: { source: { name: 'next', version: '14.2.35' }, target: { name: 'next', version: '16.0.0' } }, pack: 'nextjs-upgrade@1.2.0#abc', companions: { react: '18.3.1' } }, 'scan_repo'),
    ev('scan.result', { root: '/w/app', files: { read: 41, bytes: 9001 }, skipped: [{ path: '.env', reason: 'denied' }, { path: 'node_modules', reason: 'denied' }, { path: '../x', reason: 'outside_root' }] }, 'scan_repo'),
    ev('repo.hash', { phase: 'scan', hash: 'a'.repeat(64), files: 41 }, 'scan_repo'),
    ev('tool.end', { duration_ms: 120 }, 'scan_repo'),
    ev('usages.result', { total: 17, unparsed_files: [{ file: 'app/broken.tsx', lang: 'tsx', line: 3, message: 'unexpected token', partial: true }], unresolved_dynamic: [{ file: 'app/dyn.ts', line: 8, kind: 'import', expr: 'x' }], skipped_by_limit: [], skipped_generated: ['.next'], peer_data_unavailable: ['yarn.lock'] }, 'find_usages'),
    ev('tool.end', { duration_ms: 230 }, 'find_usages'),
    ev('scope.proposed', { size: 'full', reasons: ['12 matched usages, over the small limit of 10', 'an unresolved dynamic import'], questions: ['stop_at', 'include_deprecated'], defaults: { stop_at: '16', include_deprecated: 'yes' }, small_max_usages: 10 }, 'propose_scope'),
    ev('scope.set', { size: 'full', answers: { stop_at: '15', include_deprecated: 'yes' }, defaults: ['include_deprecated'], out_of_scope: 2, excluded: [{ usage_id: 'u-5', reason: 'scope: stop_at=15' }, { usage_id: 'u-6', reason: 'scope: stop_at=15' }] }, 'set_scope'),
    ev('docs.retrieved', { doc_id: 'd1', url: 'https://nextjs.org/docs/a', library: 'next', version: '16', fetched_by: 'agent', official: true, status: 'fresh' }, 'get_migration_docs'),
    ev('docs.retrieved', { doc_id: 'd2', url: 'https://blog.example/b', library: 'next', version: '16', fetched_by: 'agent', official: false, status: 'unverified' }, 'get_migration_docs'),
    ev('docs.retrieved', { doc_id: 'd3', url: 'https://nextjs.org/docs/c', library: 'next', version: '15', fetched_by: 'knowledge', official: true, status: 'unverified' }, 'get_migration_docs'),
    ev('docs.fallback', { reason: 'context7 not configured' }, 'get_migration_docs'),
    ev('lens.invalid', { lens: 'verification', attempt: 1, errors: [] }, 'submit_findings'),
    ev('lens.invalid', { lens: 'verification', attempt: 2, errors: [] }, 'submit_findings'),
    ev('lens.gap', { lens: 'verification', attempts: 2 }, 'submit_findings'),
    ev('cost.reported', { tokens_in: 1500, tokens_out: 250 }, 'submit_findings', [1500, 250]),
    ev('tool.end', { duration_ms: 40 }, 'submit_findings'),
    ev('budget.cut', { what: 'lens', id: 'behavior_runtime', reason: 'tokens 1750 over the budget of 1000' }, 'get_lens_packet'),
    ev('tool.start', { input: { run_id: 'run-a' } }, 'merge_findings'),
    ev('merge.started', { size: 'full' }, 'merge_findings'),
    ev('conflict', { kind: 'severity', detail: 'f1 and f2 merged; kept high over medium' }, 'merge_findings'),
    ev('findings.dropped', { ids: ['f9'] }, 'merge_findings'),
    ev('merge.result', { size: 'full', stages: 3, findings: 6, uncovered: 2, conflicts: 1 }, 'merge_findings'),
    ev('tool.end', { duration_ms: 15 }, 'merge_findings'),
    ev('gate.result', { round: 1, status: 'failed', results: [{ gate: 'g1_evidence', subject: null, pass: true, reason: 'ok' }, { gate: 'g2_coverage', subject: 'u-3', pass: false, reason: 'usage u-3 is not covered' }] }, 'validate_plan'),
    ev('gate.result', { round: 2, status: 'passed', results: [{ gate: 'g1_evidence', subject: null, pass: true, reason: 'ok' }, { gate: 'g2_coverage', subject: null, pass: true, reason: 'ok' }] }, 'validate_plan'),
    ev('routing.result', { threshold: 0.6, threshold_source: 'default', review_first: [{ reason: 'scope_breaks', finding_id: null, stage_id: null, usage_id: 'u-5', detail: 'x' }], needs_human: ['f4', 'f5'], main: 4 }, 'emit_plan'),
    ev('repo.hash', { phase: 'emit', hash: 'a'.repeat(64), files: 41 }, 'emit_plan'),
    ev('report.facts', {
      versions: { engine: '0.0.0', pack: 'nextjs-upgrade@1.2.0#abc', pack_version: '1.2.0', prompt: 'v1', codemod_registry: '0123456789ab', gates: ['g1_evidence', 'g2_coverage'] },
      plan: { status: 'passed', round: 2, stages: 3, findings: 6, unresolved: 0, l1_unresolved_stages: 0 },
      coverage: { found: 17, covered: 11, out_of_scope: { scope: { 'scope: stop_at=15': 2 }, engine: { 'no rule in range': 3 }, api: { 'already awaited': 1 } }, uncovered: 0 },
      budget: { limits: { tokens: 1000 }, used: { tokens: 1750, seconds: 61 } },
    }, 'emit_plan'),
  ];
}

function l1Log(): ReportEvent[] {
  const base = l0Log();
  clock += 1000;
  const verify = [
    ev('sandbox.created', { path: '/o/run-a/sandbox', source_head: 'deadbeef' }, 'verify_stage'),
    ev('exec.run', { kind: 'git', argv: ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '/w/app', '/o/run-a/sandbox'], exit_code: 0, duration_ms: 31, timed_out: false }, 'verify_stage'),
    ev('exec.run', { kind: 'install', argv: ['npm', 'ci'], exit_code: 0, duration_ms: 4321, timed_out: false }, 'verify_stage'),
    ev('exec.run', { kind: 'check', argv: ['npm', 'test'], exit_code: 0, duration_ms: 777, timed_out: false }, 'verify_stage'),
    ev('exec.run', { kind: 'codemod', argv: ['npx', '@next/codemod@15.3.3', 'next-async-request-api', '/o/run-a/sandbox'], exit_code: 0, duration_ms: 2222, timed_out: false }, 'verify_stage'),
    ev('exec.run', { kind: 'check', argv: ['npm', 'test'], exit_code: 1, duration_ms: 888, timed_out: false }, 'submit_stage_patch'),
    ev('exec.run', { kind: 'check', argv: ['npm', 'test'], exit_code: 0, duration_ms: 999, timed_out: false }, 'submit_stage_patch'),
    ev('verify.report', {
      run_id: 'run-a',
      sandbox_path: '/o/run-a/sandbox',
      source_head: 'deadbeef',
      baseline_checks: [{ name: 'test', status: 'pass', exit_code: 0, output_tail: '', duration_ms: 0 }],
      stages: [
        { stage_id: 'stage-prep', title: 'Prep', decision: 'kept', patch_path: 'run-a/patches/stage-prep.patch', attempts: [
          { run_id: 'run-a', stage_id: 'stage-prep', attempt: 1, codemods: [{ id: 'next-codemod:next-async-request-api', status: 'ok', diff: '', duration_ms: 2222 }], patch_hash: 'h', checks: [{ name: 'test', status: 'flaky', exit_code: 0, output_tail: '', duration_ms: 1887 }], gate7: { pass: true, violations: [] }, decision: 'kept' },
        ] },
        { stage_id: 'stage-bump', title: 'Bump', decision: 'rejected', patch_path: null, attempts: [
          { run_id: 'run-a', stage_id: 'stage-bump', attempt: 1, codemods: [], patch_hash: 'h2', checks: [{ name: 'test', status: 'pass', exit_code: 0, output_tail: '', duration_ms: 655 }], gate7: { pass: false, violations: [{ rule: 'fewer_test_cases', file: 'a.test.ts', detail: '2 -> 1' }] }, decision: 'rejected' },
        ] },
      ],
      apply_command: 'git apply /o/run-a/patches/stage-prep.patch',
    }, 'emit_plan'),
  ];
  // The verify events come before emit's own facts, as emit_plan records them.
  const at = base.findIndex((e) => e.kind === 'routing.result');
  return [...base.slice(0, at), ...verify, ...base.slice(at)];
}

describe('run_report.md from fixture event logs', () => {
  it('L0: every section, with each number taken from its event', async () => {
    const md = buildRunReport('run-a', l0Log());
    // Summary block first.
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Inputs'));
    expect(md).toContain('- Plan: passed after round 2; 3 stages, 6 findings, 0 unresolved');
    expect(md).toContain('- Coverage: 11 of 17 usages covered by findings, 0 uncovered');
    expect(md).toContain('- Review first: 1; needs human decision: 2 (confidence threshold 0.6, default)');
    expect(md).toContain('- Target repo untouched: yes (hash unchanged)');
    // Inputs, IDs and versions.
    expect(md).toContain('- Campaign `camp-7`, repo `repo-9`');
    expect(md).toContain('- Resolved: next 14.2.35 → next 16.0.0');
    expect(md).toContain('- Companions installed: react 18.3.1');
    expect(md).toContain('- Gates: g1_evidence, g2_coverage; codemod registry 0123456789ab');
    // Size and scope: reasons, each answer marked when default, the usages each answer excluded.
    expect(md).toContain('  - 12 matched usages, over the small limit of 10');
    expect(md).toContain('- stop_at: `15`\n');
    expect(md).toContain('- include_deprecated: `yes` (default)');
    expect(md).toContain('- scope: stop_at=15 excluded 2 usages:\n  - `u-5`\n  - `u-6`');
    // Coverage split by written_by.
    expect(md).toContain('- Out of scope: 6');
    expect(md).toContain('  - by api: 1 — already awaited');
    expect(md).toContain('  - by engine: 3 — no rule in range');
    expect(md).toContain('  - by scope: 2 — scope: stop_at=15');
    // Unparsed and skipped.
    expect(md).toContain('- Files read: 41 (9001 bytes)');
    expect(md).toContain('- Skipped at scan (denied): 2');
    expect(md).toContain('- Skipped at scan (outside_root): 1');
    expect(md).toContain('  - `app/broken.tsx` (partial): unexpected token');
    expect(md).toContain('  - `app/dyn.ts:8` (import)');
    // Docs split by fetched_by and official, with fallbacks and the plain note.
    expect(md).toContain('- Docs used: 3 (fresh 1, stale 0, unverified 2)');
    expect(md).toContain('  - fetched by agent: 2 (official 1, not official 1)');
    expect(md).toContain('  - fetched by knowledge: 1 (official 1, not official 0)');
    expect(md).toContain('- Fallback events (Context7 unavailable, cache or knowledge used): 1');
    expect(md).toContain('checked for where they come from, not for what they say');
    // Gates per round.
    expect(md).toContain('- Round 1: failed, 1 pass, 1 fail\n  - g2_coverage [u-3]: usage u-3 is not covered');
    expect(md).toContain('- Round 2: passed, 2 pass, 0 fail');
    // Dropped and why.
    expect(md).toContain('  - severity: f1 and f2 merged; kept high over medium');
    expect(md).toContain('scope left them covering no usage): 1 — f9');
    expect(md).toContain('- Lens gaps (two invalid submissions): 1 — verification');
    expect(md).toContain('- Invalid lens submissions: 2');
    expect(md).toContain('  - lens `behavior_runtime`: tokens 1750 over the budget of 1000');
    // Cost and time per step.
    expect(md).toContain('| scan_repo | 1 | 120 | 0 |');
    expect(md).toContain('| submit_findings | 1 | 40 | 1750 |');
    expect(md).toContain('- Budget: tokens 1000, seconds none; used 1750 tokens over 61 s of run time');
    // Repo untouched, with both hashes.
    expect(md).toContain(`- Before (scan): \`${'a'.repeat(64)}\` over 41 files`);
    expect(md).toContain(`- After (emit): \`${'a'.repeat(64)}\` over 41 files`);
    // No verify section at L0.
    expect(md).not.toContain('## Verify');
    await expect(md).toMatchFileSnapshot('../fixtures/report/l0.md');
  });

  it('L1: the verify section matches the verify report and the exec events', async () => {
    const log = l1Log();
    const md = buildRunReport('run-a', log);
    const verify = md.slice(md.indexOf('## Verify (L1)'), md.indexOf('## Dropped'));
    expect(verify).toContain('- Sandbox: `/o/run-a/sandbox` at source HEAD `deadbeef`');
    expect(verify).toContain('  - test: pass (exit 0)');
    expect(verify).toContain('- Stage `stage-prep` (Prep): kept, 1 attempt, patch `run-a/patches/stage-prep.patch`');
    expect(verify).toContain('  - attempt 1: kept; checks: test flaky exit 0 in 1887 ms; gate 7 pass; codemods: next-codemod:next-async-request-api ok');
    expect(verify).toContain('- Stage `stage-bump` (Bump): rejected, 1 attempt');
    expect(verify).toContain('gate 7 fail (fewer_test_cases a.test.ts)');
    expect(verify).toContain('- Flaky checks: test');
    // Every command with its exit code: one line per exec.run event.
    const execs = log.filter((e) => e.kind === 'exec.run');
    expect(verify).toContain(`- Commands run: ${execs.length}`);
    expect(verify).toContain('  - [install] `npm ci` → exit 0 in 4321 ms');
    expect(verify).toContain('  - [check] `npm test` → exit 1 in 888 ms');
    // Network-using steps: install, codemod and checks; the local clone is not one.
    expect(verify).toContain('- Steps that may use the network: 5');
    expect(verify).toContain('  - 3 × your check command');
    expect(verify).toContain('  - 1 × your install command');
    expect(verify).toContain('  - 1 × a pinned codemod');
    expect(verify).toContain('- Apply the kept patches yourself: `git apply /o/run-a/patches/stage-prep.patch`');
    expect(md).toContain('- Verify (L1): 1 of 2 stages kept');
    await expect(md).toMatchFileSnapshot('../fixtures/report/l1.md');
  });

  it('says what was not recorded rather than inventing a number', () => {
    const md = buildRunReport('run-z', [ev('tool.start', { input: {} }, 'scan_repo')]);
    expect(md).toContain('- Campaign and repo IDs: _not recorded_');
    expect(md).toContain('- Target repo untouched: not checked');
    expect(md).not.toMatch(/Coverage: \d/);
  });

  it('a changed hash is reported, not hidden', () => {
    const log = l0Log().map((e) => (e.kind === 'repo.hash' && e.step === 'emit_plan' ? { ...e, payload_json: JSON.stringify({ phase: 'emit', hash: 'b'.repeat(64), files: 42 }) } : e));
    const md = buildRunReport('run-a', log);
    expect(md).toContain('- Target repo untouched: **hash changed**');
    expect(md).toContain('The hashes differ.');
  });

  it('treeHash depends on paths and contents, not on file order', () => {
    const a = [{ path: 'a', sha256: '1' }, { path: 'b', sha256: '2' }];
    expect(treeHash(a)).toBe(treeHash([...a].reverse()));
    expect(treeHash(a)).not.toBe(treeHash([{ path: 'a', sha256: '1' }, { path: 'b', sha256: '3' }]));
  });
});

describe('run_report.md from a real run', () => {
  it('the report emit writes equals one rebuilt from the store after the engine closed', async () => {
    const out = tmpDir();
    const repo = path.join(tmpDir(), 'next-tricky');
    cpSync(path.join(repoRoot, 'eval/seeded/next-tricky'), repo, { recursive: true });
    const engine = createEngine({ out });
    let id: string;
    let written: string;
    try {
      const scan = await scanRepo(engine, { repo_path: repo, source: { name: 'next' }, target: { name: 'next', version: '16.0.0' } });
      id = scan.run!.run_id;
      await findUsages(engine, { run_id: id });
      await proposeScope(engine, { run_id: id });
      await setScope(engine, { run_id: id, answers: {} });
      await mergeFindings(engine, { run_id: id });
      await validatePlan(engine, { run_id: id });
      const emitted = await emitPlan(engine, { run_id: id });
      written = readFileSync(path.join(out, emitted.run_report), 'utf8');
    } finally {
      closeEngine(engine);
    }
    const db = openDb(path.join(out, 'store.sqlite'));
    try {
      const events = listEvents(db, id);
      // emit_plan wrote the report before its own emit.result and tool.end, so rebuild from the events before those.
      const upTo = events.findLastIndex((e) => e.kind === 'emit.result');
      expect(buildRunReport(id, events.slice(0, upTo))).toBe(written);
    } finally {
      db.close();
    }
    expect(written).toContain('- Target repo untouched: yes (hash unchanged)');
    expect(written).toMatch(/- Usages found: \d+/);
  });
});
