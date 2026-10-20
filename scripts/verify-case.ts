// Golden-case re-checker (M7 task 8, D11). Re-checks committed cases against
// GitHub: the commits are still fetchable, the parentage holds, the versions at
// base and merge match the record, the licence is unchanged and on the open
// allowlist, and the declared test command exists at base. One line per check,
// non-zero exit on any mismatch. Maintainer tooling: uses gh/git over the
// network, never in default CI, never imported by src/ (INV-40).
//
//   npm run cases:verify -- <id> | --all
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Case } from '../eval/schema.js';
import { hasTestAtBase, licenseAllowed, parentageHolds, versionFromLockfile, versionsMatch } from '../eval/caseVet.js';

const top = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Read the installed version of `library` from a repo checkout's lockfile (npm only, the Next.js pack). */
function lockfileVersion(root: string, library: string): string | null {
  const lock = path.join(root, 'package-lock.json');
  if (!existsSync(lock)) return null;
  const data = JSON.parse(readFileSync(lock, 'utf8')) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  const pkg = data.packages?.[`node_modules/${library}`]?.version ?? data.dependencies?.[library]?.version ?? null;
  return pkg ? versionFromLockfile({ [library]: pkg }, library) : null;
}

function verifyOne(id: string): boolean {
  const casePath = path.join(top(), 'eval', 'cases', id, 'case.json');
  if (!existsSync(casePath)) {
    process.stderr.write(`no case ${id}\n`);
    return false;
  }
  const kase = Case.parse(JSON.parse(readFileSync(casePath, 'utf8')));
  const work = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'mp-verify-'));
  const clone = path.join(work, id);
  let ok = true;
  const line = (name: string, pass: boolean, detail: string): void => {
    ok = ok && pass;
    process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${id} ${name}: ${detail}\n`);
  };
  try {
    execFileSync('git', ['clone', '--no-checkout', kase.repo_url, clone], { stdio: 'ignore' });
    const git = (...a: string[]): string => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
    let baseOk = true;
    let mergeOk = true;
    try { git('fetch', '--depth', '1', 'origin', kase.base_commit); } catch { baseOk = false; }
    try { git('fetch', '--depth', '1', 'origin', kase.merge_commit); } catch { mergeOk = false; }
    line('base fetchable', baseOk, kase.base_commit);
    line('merge fetchable', mergeOk, kase.merge_commit);
    if (baseOk && mergeOk) {
      const parents = git('rev-list', '--parents', '-n', '1', kase.merge_commit).trim().split(/\s+/).slice(1);
      line('parentage', parentageHolds(kase.base_commit, parents), `parents ${parents.join(', ')}`);
      git('checkout', '--force', kase.merge_commit);
      const mergeVersion = lockfileVersion(clone, kase.source.framework);
      git('checkout', '--force', kase.base_commit);
      const baseVersion = lockfileVersion(clone, kase.source.framework);
      const v = versionsMatch({ source: kase.source.version, target: kase.target.version }, { baseVersion, mergeVersion });
      line('versions', v.ok, v.reason);
      const pkgPath = path.join(clone, 'package.json');
      const pkg = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }) : {};
      const hasTest = Boolean(pkg.scripts?.['test']);
      const hasCi = existsSync(path.join(clone, '.github', 'workflows'));
      line('test or CI at base', hasTestAtBase({ hasTestScript: hasTest, hasCiWorkflow: hasCi }), `test ${hasTest}, ci ${hasCi}`);
    }
    line('licence on allowlist', licenseAllowed(kase.license), `licence ${kase.license}`);
    return ok;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const all = argv.includes('--all');
  const ids = all
    ? execFileSync('ls', [path.join(top(), 'eval', 'cases')], { encoding: 'utf8' }).split('\n').filter((n) => n && !n.endsWith('.json') && !n.endsWith('.md'))
    : argv.filter((a) => !a.startsWith('--'));
  if (ids.length === 0) {
    process.stderr.write('usage: npm run cases:verify -- <id> | --all\n');
    return 1;
  }
  let ok = true;
  for (const id of ids) ok = verifyOne(id) && ok;
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
