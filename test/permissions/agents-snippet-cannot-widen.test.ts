// INV-5: the AGENTS.md snippet can add deny entries and cannot remove one or
// point outside the root. The path boundary is unchanged.
import { afterEach, describe, expect, it } from 'vitest';
import { closeEngine, createEngine, scanRepo, type Engine } from '../../src/core/index.js';
import { isDeniedRel, userDenyGlobs } from '../../src/security/denyList.js';
import { resolveInside } from '../../src/security/pathBoundary.js';
import { readText } from '../../src/security/safeRead.js';
import { expectPermission, tmpDir, writeTree } from '../helpers.js';

const SECRET = 'TOP_SECRET_VALUE';
const agents = `
## migration-planner
\`\`\`yaml
planner_deny:
  - !.env
  - ../outside
  - /etc/passwd
  - foo/../../outside
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
    for (const glob of ['!.env', '../outside', '/etc/passwd', 'foo/../../outside']) {
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
});
