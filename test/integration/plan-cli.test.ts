// The merge/validate/emit CLI commands (M6 adapters), end to end on a seeded
// repo. The CLI runs scan -> usages -> scope -> merge -> validate -> emit and
// writes only under --out; the repo's hash is unchanged (INV-1, D37).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoHash } from '../../scripts/repo-hash.js';
import { Plan } from '../../src/schema/plan.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';

describe('plan CLI (merge, validate, emit)', () => {
  it('emits a plan.json and MIGRATION_PLAN.md outside the repo and leaves the repo untouched', () => {
    const repo = copyFixture('next-clean');
    const out = tmpDir();
    const before = repoHash(repo);

    const emit = runCli(['emit', repo, '--source', 'next', '--target', 'next@16.0.0', '--out', out]);
    expect(emit.stderr).not.toContain('refused');
    expect(emit.status).toBe(0);
    const emitted = JSON.parse(emit.stdout) as { run_id: string; status: string; plan_json: string; plan_md: string };
    expect(emitted.status).toBe('passed');

    const jsonPath = path.join(out, emitted.plan_json);
    const mdPath = path.join(out, emitted.plan_md);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    // Parses as a Plan, and nothing lands inside the repo tree.
    expect(() => Plan.parse(JSON.parse(readFileSync(jsonPath, 'utf8')))).not.toThrow();
    expect(jsonPath.startsWith(path.resolve(repo))).toBe(false);
    expect(repoHash(repo)).toBe(before);
  });

  it('merge then validate report the gate outcome as text', () => {
    const repo = copyFixture('next-clean');
    const merge = runCli(['merge', repo, '--source', 'next', '--target', 'next@16.0.0', '--out', tmpDir(), '--format', 'text']);
    expect(merge.status, merge.stderr).toBe(0);
    expect(merge.stdout).toContain('size none');
    expect(merge.stdout).toContain('stage 1:');

    const validate = runCli(['validate', repo, '--source', 'next', '--target', 'next@16.0.0', '--out', tmpDir(), '--format', 'text']);
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain('status passed');
    expect(validate.stdout).toContain('0 fail');
  });
});
