// INV-8: snippet checks are ignored without --trust-repo-checks, and CLI flags
// replace them. A tool argument cannot turn the trust flag on.
import { afterEach, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, ingest, InputError, type Engine, type EngineOptions } from '../../src/core/index.js';
import { runCli, tmpDir, writeTree } from '../helpers.js';

const agents = `
## migration-planner
\`\`\`yaml
checks:
  install: npm ci
  typecheck: npx tsc --noEmit
targets:
  - next@15
\`\`\`
`;

function repo(): string {
  const root = tmpDir();
  writeTree(root, {
    'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
    'AGENTS.md': agents,
    'src/ok.ts': 'export const ok = 1;\n',
  });
  return root;
}

const input = (root: string): Record<string, unknown> => ({
  repo_path: root,
  source: { name: 'next', version: '14.2' },
  target: { name: 'next', version: '15.1.0' },
});

describe('snippet checks need --trust-repo-checks', () => {
  const open: Engine[] = [];
  afterEach(() => {
    for (const e of open) closeEngine(e);
    open.length = 0;
  });

  function start(log: (message: string) => void, extra: Partial<EngineOptions> = {}): Engine {
    const e = createEngine({ out: tmpDir(), log, ...extra });
    open.push(e);
    return e;
  }

  it('ignores snippet checks unless the process was started with --trust-repo-checks', async () => {
    const logs: string[] = [];
    const e = start((m) => logs.push(m));
    const res = await ingest(e, input(repo()));
    expect(res.status).toBe('ok');
    expect(e.options.checks ?? []).toEqual([]);
    expect(e.options.installs ?? []).toEqual([]);
    expect(logs).toContain('  install: npm ci');
    expect(logs).toContain('  typecheck: npx tsc --noEmit');
    expect(logs).toContain('AGENTS.md snippet checks ignored: pass --trust-repo-checks to use them');
    expect(logs.join('\n')).not.toContain('checks used');
  });

  it('uses the snippet checks when trusted and the CLI set none', async () => {
    const logs: string[] = [];
    const e = start((m) => logs.push(m), { trustRepoChecks: true });
    const res = await ingest(e, input(repo()));
    expect(res.status).toBe('ok');
    expect(e.options.installs?.map((c) => c.argv)).toEqual([['npm', 'ci']]);
    expect(e.options.checks?.map((c) => ({ name: c.name, argv: c.argv }))).toEqual([{ name: 'typecheck', argv: ['npx', 'tsc', '--noEmit'] }]);
    expect(logs).toContain('AGENTS.md snippet checks used (--trust-repo-checks)');
  });

  it('keeps CLI checks when both the trust flag and CLI flags are set', async () => {
    const logs: string[] = [];
    const cliCheck = { name: 'unit', argv: ['npm', 'test'], timeout_ms: 120_000 };
    const e = start((m) => logs.push(m), { trustRepoChecks: true, checksFromCli: true, checks: [cliCheck], installs: [] });
    const res = await ingest(e, input(repo()));
    expect(res.status).toBe('ok');
    expect(e.options.checks).toEqual([cliCheck]);
    expect(e.options.installs ?? []).toEqual([]);
    expect(logs).toContain('AGENTS.md snippet checks ignored: CLI flags set the check config');
    expect(logs.join('\n')).not.toContain('checks used');
  });

  it('keeps the first adopted snippet check set when a second repo names different checks', async () => {
    const logs: string[] = [];
    const e = start((m) => logs.push(m), { trustRepoChecks: true });
    const first = repo();
    const second = tmpDir();
    writeTree(second, {
      'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'src/ok.ts': 'export const ok = 1;\n',
      'AGENTS.md': `
## migration-planner
\`\`\`yaml
checks:
  install: pip install -r requirements.txt
  lint: ruff check .
targets:
  - next@15
\`\`\`
`,
    });
    const a = await ingest(e, input(first));
    const b = await ingest(e, input(second));
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(e.options.installs?.map((c) => c.argv)).toEqual([['npm', 'ci']]);
    expect(e.options.checks?.map((c) => ({ name: c.name, argv: c.argv }))).toEqual([{ name: 'typecheck', argv: ['npx', 'tsc', '--noEmit'] }]);
    expect(logs).toContain('AGENTS.md snippet checks used (--trust-repo-checks)');
    expect(logs).toContain('AGENTS.md snippet checks ignored: the check config is already frozen');
    expect(logs.filter((m) => m === 'AGENTS.md snippet checks ignored: the check config is already frozen')).toHaveLength(1);
    expect(e.options.installs?.some((c) => c.argv.join(' ').includes('pip'))).toBe(false);
    expect(e.options.checks?.some((c) => c.name === 'lint')).toBe(false);
  });

  it('refuses a tool argument that tries to set the trust flag', async () => {
    const e = start(() => {});
    await expect(ingest(e, { ...input(repo()), trust_repo_checks: true })).rejects.toBeInstanceOf(InputError);
    expect(e.options.checks ?? []).toEqual([]);
    expect(e.options.installs ?? []).toEqual([]);
    expect(e.options.trustRepoChecks).not.toBe(true);
  });
});

describe('CLI flag wiring', () => {
  const root = repo();
  const out = (): string => tmpDir();
  const base = ['scan', root, '--source', 'next@14.2', '--target', 'next@15.1.0'];

  it('prints the snippet checks and ignores them without the flag', () => {
    const res = runCli([...base, '--out', out()]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('  install: npm ci');
    expect(res.stderr).toContain('AGENTS.md snippet checks ignored: pass --trust-repo-checks to use them');
    expect(res.stderr).not.toContain('checks used');
  });

  it('uses the snippet checks with --trust-repo-checks', () => {
    const res = runCli([...base, '--out', out(), '--trust-repo-checks']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('AGENTS.md snippet checks used (--trust-repo-checks)');
  });

  it('lets --check override the snippet even with --trust-repo-checks', () => {
    const res = runCli([...base, '--out', out(), '--trust-repo-checks', '--check', 'unit=npm test']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('AGENTS.md snippet checks ignored: CLI flags set the check config');
    expect(res.stderr).not.toContain('checks used');
  });
});
