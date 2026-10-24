// INV-5: the AGENTS.md snippet can add deny entries and cannot remove one or
// point outside the root. The path boundary is unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, ingest, scanRepo, type Engine } from '../../src/core/index.js';
import { isDeniedRel, MAX_USER_DENY_DOUBLE_STARS, MAX_USER_DENY_ENTRIES, MAX_USER_DENY_GLOB_LENGTH, userDenyGlobs } from '../../src/security/denyList.js';
import { resolveInside } from '../../src/security/pathBoundary.js';
import { readText } from '../../src/security/safeRead.js';
import { expectPermission, tmpDir, writeTree } from '../helpers.js';

const SECRET = 'TOP_SECRET_VALUE';
/** Windows forms of "outside the root": a drive path, a UNC share, and `..` on backslashes. */
const WIN_ABS = 'C:\\outside';
const WIN_UNC = '\\\\server\\share';
const WIN_PARENT = 'foo\\..\\..\\outside';
const agents = `
## migration-planner
\`\`\`yaml
planner_deny:
  - !.env
  - ../outside
  - /etc/passwd
  - foo/../../outside
  - ${WIN_ABS}
  - ${WIN_UNC}
  - ${WIN_PARENT}
  - planner-kept/**
checks:
  install: echo snippet-install
\`\`\`
## later
\`\`\`yaml
planner_deny:
  - "!.env"
\`\`\`
`;

function repo(): string {
  const root = tmpDir();
  writeTree(root, {
    'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
    'AGENTS.md': agents,
    '.env': `${SECRET}\n`,
    'src/ok.ts': 'export const ok = 1;\n',
    'planner-kept/secret.txt': 'hidden\n',
  });
  return root;
}

describe('AGENTS.md snippet cannot widen the boundary', () => {
  const open: Engine[] = [];
  afterEach(() => {
    for (const e of open) closeEngine(e);
    open.length = 0;
  });

  it('rejects negation, parent paths and absolute paths, and still denies .env', async () => {
    const logs: string[] = [];
    const e = createEngine({ out: tmpDir(), log: (m) => logs.push(m) });
    open.push(e);
    const root = repo();
    const res = await scanRepo(e, {
      repo_path: root,
      source: { name: 'next' },
      target: { name: 'next', version: '15.1.0' },
    });
    expect(res.status).toBe('ok');
    expect(logs).toContain('AGENTS.md snippet: rejected planner_deny "!.env" (a deny entry cannot remove a denial)');
    expect(logs).toContain('AGENTS.md snippet: rejected planner_deny "../outside" (path is outside the repo root)');
    expect(logs).toContain('AGENTS.md snippet: rejected planner_deny "/etc/passwd" (path is outside the repo root)');
    expect(logs).toContain('AGENTS.md snippet: rejected planner_deny "foo/../../outside" (path is outside the repo root)');
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${WIN_ABS}" (path is outside the repo root)`);
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${WIN_UNC}" (path is outside the repo root)`);
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${WIN_PARENT}" (path is outside the repo root)`);
    for (const glob of ['!.env', '../outside', '/etc/passwd', 'foo/../../outside', WIN_ABS, WIN_UNC, WIN_PARENT]) {
      expect(userDenyGlobs()).not.toContain(glob);
    }
    expect(userDenyGlobs()).toContain('planner-kept/**');
    expect(isDeniedRel('.env')).toBe(true);
    expect(isDeniedRel('planner-kept/secret.txt')).toBe(true);
    const denied = expectPermission(() => readText(resolveInside(root, '.env')), 'denied');
    expect(denied.message).not.toContain(SECRET);
    expectPermission(() => resolveInside(root, '../outside'), 'outside_root');
    expectPermission(() => resolveInside(root, '/etc/passwd'), 'outside_root');
    expectPermission(() => resolveInside(root, 'foo/../../outside'), 'outside_root');
    expect(readText(resolveInside(root, 'src/ok.ts'))).toContain('ok');
    expect(res.scan!.skipped).toContainEqual({ path: '.env', reason: 'denied' });
    expect(res.scan!.skipped).toContainEqual({ path: 'planner-kept/secret.txt', reason: 'denied' });
  });

  it('rejects a pathological planner_deny glob and still scans a long path quickly', async () => {
    // Eight `**` becomes eight `.*` and takes about two seconds on one long path.
    // The limit is smaller than that, so this glob is rejected before it is compiled.
    const slow = 'src/**a**a**a**a**a**a**a**a**b';
    expect((slow.match(/\*\*/g) ?? []).length).toBeGreaterThan(MAX_USER_DENY_DOUBLE_STARS);
    const tooLong = 'x'.repeat(MAX_USER_DENY_GLOB_LENGTH + 1);
    const logs: string[] = [];
    const e = createEngine({ out: tmpDir(), log: (m) => logs.push(m) });
    open.push(e);
    const root = tmpDir();
    // 38 a's is about two seconds per check in the unguarded matcher. The walk
    // checks the path twice. A longer name blocks the scan for a long time.
    const longName = `${'a'.repeat(38)}.ts`;
    writeTree(root, {
      'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'AGENTS.md': `
## migration-planner
\`\`\`yaml
planner_deny:
  - ${slow}
  - ${tooLong}
\`\`\`
`,
      [`src/${longName}`]: 'export const long = 1;\n',
    });
    const started = performance.now();
    const res = await scanRepo(e, {
      repo_path: root,
      source: { name: 'next' },
      target: { name: 'next', version: '15.1.0' },
    });
    const elapsed = performance.now() - started;
    expect(res.status).toBe('ok');
    expect(elapsed).toBeLessThan(1000);
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${slow}" (deny glob has more than ${MAX_USER_DENY_DOUBLE_STARS} "**")`);
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${tooLong}" (deny glob is longer than ${MAX_USER_DENY_GLOB_LENGTH} characters)`);
    expect(userDenyGlobs()).not.toContain(slow);
    expect(userDenyGlobs()).not.toContain(tooLong);
    expect(res.scan!.files.read).toBeGreaterThan(0);
  });

  it('accepts a chain of single `*` and still scans long file names quickly', async () => {
    // No `**` and under the length limit, so every limit lets it in. As a
    // regex each `*` was `[^/]*`, and a chain of them backtracks: 18 characters
    // took 33 seconds on three 40-character names (D58).
    const chain = `${'*a'.repeat(40)}*b`;
    expect(chain).not.toContain('**');
    expect(chain.length).toBeLessThanOrEqual(MAX_USER_DENY_GLOB_LENGTH);
    const logs: string[] = [];
    const e = createEngine({ out: tmpDir(), log: (m) => logs.push(m) });
    open.push(e);
    const root = tmpDir();
    const names = [0, 1, 2].map((i) => `${'a'.repeat(200)}${i}.ts`);
    const matching = `${'a'.repeat(210)}b`;
    writeTree(root, {
      'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'AGENTS.md': `
## migration-planner
\`\`\`yaml
planner_deny:
  - "${chain}"
\`\`\`
`,
      ...Object.fromEntries(names.map((n) => [`src/${n}`, 'export const long = 1;\n'])),
      [`src/${matching}`]: 'hidden\n',
    });
    const started = performance.now();
    const res = await scanRepo(e, {
      repo_path: root,
      source: { name: 'next' },
      target: { name: 'next', version: '15.1.0' },
    });
    const elapsed = performance.now() - started;
    expect(res.status).toBe('ok');
    expect(elapsed).toBeLessThan(1000);
    expect(userDenyGlobs()).toContain(chain);
    expect(logs.filter((l) => l.includes('rejected planner_deny'))).toEqual([]);
    expect(res.scan!.skipped).toContainEqual({ path: `src/${matching}`, reason: 'denied' });
    for (const n of names) expect(res.scan!.skipped).not.toContainEqual({ path: `src/${n}`, reason: 'denied' });
  });

  it('does not add the same planner_deny globs again when one engine ingests the repo again', async () => {
    // Every tool call that ingests re-reads the snippet. Without the identity
    // check, ten calls left 320 globs, and every file check paid for all of them.
    const globs = Array.from({ length: MAX_USER_DENY_ENTRIES }, (_, i) => `repeat-${i}/**`);
    const logs: string[] = [];
    const e = createEngine({ out: tmpDir(), log: (m) => logs.push(m) });
    open.push(e);
    const root = tmpDir();
    writeTree(root, {
      'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'AGENTS.md': `
## migration-planner
\`\`\`yaml
planner_deny:
${globs.map((g) => `  - ${g}`).join('\n')}
\`\`\`
`,
      'src/ok.ts': 'export const ok = 1;\n',
      'repeat-0/secret.txt': 'hidden\n',
    });
    const input = { repo_path: root, source: { name: 'next' }, target: { name: 'next', version: '15.1.0' } };
    const first = await scanRepo(e, input);
    const again = await ingest(e, input);
    const third = await scanRepo(e, input);
    expect(first.status).toBe('ok');
    expect(again.status).toBe('ok');
    expect(third.status).toBe('ok');
    expect(userDenyGlobs().filter((g) => g.startsWith('repeat-'))).toHaveLength(MAX_USER_DENY_ENTRIES);
    expect(new Set(userDenyGlobs()).size).toBe(userDenyGlobs().length);
    expect(logs.filter((l) => l.includes('rejected planner_deny'))).toEqual([]);
    expect(third.scan!.skipped).toContainEqual({ path: 'repeat-0/secret.txt', reason: 'denied' });
  });

  it('rejects planner_deny entries past the cap for one snippet', async () => {
    const globs = Array.from({ length: MAX_USER_DENY_ENTRIES + 1 }, (_, i) => `capped-${i}/**`);
    const logs: string[] = [];
    const e = createEngine({ out: tmpDir(), log: (m) => logs.push(m) });
    open.push(e);
    const root = tmpDir();
    writeTree(root, {
      'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '14.2.35' } } }),
      'AGENTS.md': `
## migration-planner
\`\`\`yaml
planner_deny:
${globs.map((g) => `  - ${g}`).join('\n')}
\`\`\`
`,
      'src/ok.ts': 'export const ok = 1;\n',
    });
    const res = await scanRepo(e, {
      repo_path: root,
      source: { name: 'next' },
      target: { name: 'next', version: '15.1.0' },
    });
    expect(res.status).toBe('ok');
    const extra = globs[MAX_USER_DENY_ENTRIES]!;
    expect(logs).toContain(`AGENTS.md snippet: rejected planner_deny "${extra}" (planner_deny is limited to ${MAX_USER_DENY_ENTRIES} entries)`);
    expect(userDenyGlobs()).not.toContain(extra);
    expect(userDenyGlobs()).toContain(globs[0]!);
    expect(userDenyGlobs()).toContain(globs[MAX_USER_DENY_ENTRIES - 1]!);
    expect(userDenyGlobs().filter((g) => g.startsWith('capped-'))).toHaveLength(MAX_USER_DENY_ENTRIES);
  });
});
