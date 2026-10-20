// Golden-case re-checker (M7 task 8, D11). Re-checks committed cases against
// GitHub: the commits are still fetchable, the parentage holds, the versions at
// base and merge match the record, the licence is unchanged and on the open
// allowlist, and the declared test command exists at base. One line per check,
// non-zero exit on any mismatch. Maintainer tooling: uses gh/git over the
// network, never in default CI, never imported by src/ (INV-40).
//
//   npm run cases:verify -- <id> | --all
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { hasTestAtBase, licenseAllowed, parentageHolds, versionFromLockfile, versionsMatch } from '../eval/caseVet.js';
import { Case } from '../eval/schema.js';
import { parsePackageJson, parsePackageLock, parsePnpmLock, parsePnpmWorkspace, parseYarnLock } from '../src/analysis/manifests/node.js';

const top = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

type GitRunner = (...args: string[]) => string;

/**
 * How many commits to fetch for the merge commit. Depth 1 makes that commit a
 * shallow boundary, so `rev-list --parents` returns no parents and parentage
 * fails for every case. Depth 2 keeps the parents in the repo (D40).
 */
export const MERGE_FETCH_DEPTH = '2';

/** Fetch the pinned commits. The base stays at depth 1; the merge uses `MERGE_FETCH_DEPTH`. */
export function fetchPinnedCommits(git: GitRunner, base: string, merge: string): { baseOk: boolean; mergeOk: boolean } {
  let baseOk = true;
  let mergeOk = true;
  try {
    git('fetch', '--depth', '1', 'origin', base);
  } catch {
    baseOk = false;
  }
  try {
    git('fetch', '--depth', MERGE_FETCH_DEPTH, 'origin', merge);
  } catch {
    mergeOk = false;
  }
  return { baseOk, mergeOk };
}

/** Parent SHAs from `git rev-list --parents -n 1` (field 0 is the commit itself). */
export function parentsFromRevList(line: string): string[] {
  const parts = line.trim().split(/\s+/).filter((part) => part.length > 0);
  return parts.slice(1);
}

/** Parent SHAs from a recorded GitHub commit (`gh api repos/<owner>/<repo>/commits/<sha>`). */
export function parentsFromGithubCommit(commit: { parents?: readonly { sha?: string }[] | null }): string[] {
  const shas: string[] = [];
  for (const parent of commit.parents ?? []) {
    if (parent.sha) shas.push(parent.sha);
  }
  return shas;
}

/** Parents of `merge` as `rev-list --parents` reports them after the fetch. */
export function readMergeParents(git: GitRunner, merge: string): string[] {
  return parentsFromRevList(git('rev-list', '--parents', '-n', '1', merge));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function unique(versions: readonly string[]): string[] {
  return [...new Set(versions)];
}

function sole(versions: readonly string[]): string | null {
  const found = unique(versions);
  return found.length === 1 ? found[0]! : null;
}

/** The semver a manifest range names (`^14.2.35`, `14.2.35`), or null for `workspace:*` and similar. */
function semverInSpec(spec: string | null): string | null {
  if (!spec) return null;
  const match = /(?:^|[^0-9])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(spec);
  return match?.[1] ?? null;
}

/** Workspace directories for one-segment `*` patterns. `..` is ignored. */
function expandWorkspaces(root: string, patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (pattern.split('/').includes('..')) continue;
    let dirs = [root];
    for (const part of pattern.split('/')) {
      if (!part || part === '.') continue;
      const next: string[] = [];
      for (const dir of dirs) {
        if (part === '*') {
          if (!existsSync(dir)) continue;
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== '.git') next.push(path.join(dir, ent.name));
          }
        } else {
          next.push(path.join(dir, part));
        }
      }
      dirs = next;
    }
    out.push(...dirs);
  }
  return out;
}

function relPosix(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join('/');
}

/** Declared specs for `library`, and workspace dirs relative to `root`, from the root manifest and its workspaces. */
function manifestInfo(root: string, library: string): { specs: (string | null)[]; importers: string[] } {
  const specs: (string | null)[] = [];
  const importers: string[] = [];
  const patterns: string[] = [];
  const rootPkg = path.join(root, 'package.json');
  const files: string[] = [];
  if (existsSync(rootPkg)) {
    files.push(rootPkg);
    try {
      patterns.push(...parsePackageJson(readFileSync(rootPkg, 'utf8')).workspaces);
    } catch {
      // A manifest that does not parse contributes no specs; the lockfile is still tried.
    }
  }
  const pnpmWs = path.join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    try {
      patterns.push(...parsePnpmWorkspace(readFileSync(pnpmWs, 'utf8')));
    } catch {
      // Same as a bad package.json: skip the workspace list, still read the lockfile.
    }
  }
  for (const dir of expandWorkspaces(root, patterns)) {
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) continue;
    files.push(pkg);
    const rel = relPosix(root, dir);
    if (rel) importers.push(rel);
  }
  for (const file of files) {
    try {
      for (const dep of parsePackageJson(readFileSync(file, 'utf8')).deps) {
        if (dep.name === library) specs.push(dep.spec);
      }
    } catch {
      // Skip one unreadable manifest; other packages in the checkout can still pin the library.
    }
  }
  return { specs, importers };
}

function fromNpm(text: string, library: string, importers: readonly string[]): string[] {
  const lookup = parsePackageLock(text);
  const versions: string[] = [];
  for (const importer of ['', ...importers]) versions.push(...lookup(library, importer, null));
  return unique(versions);
}

function fromYarn(text: string, library: string, specs: readonly (string | null)[]): string[] {
  const lookup = parseYarnLock(text);
  const selected: string[] = [];
  for (const spec of specs) {
    if (spec) selected.push(...lookup(library, '', spec));
  }
  const picked = unique(selected);
  if (picked.length > 0) return picked;
  return unique(lookup(library, '', null));
}

function fromPnpm(text: string, library: string): string[] {
  const lock = parseYaml(text) as unknown;
  const lookup = parsePnpmLock(text);
  const importers = isRecord(lock) && isRecord(lock.importers) ? Object.keys(lock.importers) : [''];
  const versions: string[] = [];
  for (const importer of importers) versions.push(...lookup(library, importer === '.' ? '' : importer, null));
  return unique(versions);
}

/** Every lockfile is read before deciding. Any `ambiguous` or `unreadable` read, or pins that differ across files, means no version, so no file or the manifest can paper over a disagreement. */
type PinRead = { kind: 'missing' } | { kind: 'none' } | { kind: 'pin'; version: string } | { kind: 'ambiguous' } | { kind: 'unreadable' };

function readPin(file: string, read: (text: string) => string[]): PinRead {
  if (!existsSync(file)) return { kind: 'missing' };
  try {
    const versions = read(readFileSync(file, 'utf8'));
    if (versions.length === 0) return { kind: 'none' };
    if (versions.length === 1) return { kind: 'pin', version: versions[0]! };
    return { kind: 'ambiguous' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Installed version of `library` at a checkout. Reads `package-lock.json`,
 * `yarn.lock` and `pnpm-lock.yaml`, all of them. One unique pin across them
 * wins. Several pins in one file, pins that differ between files, or any
 * lockfile that does not parse return null rather than guessing. When no
 * lockfile mentions the library, falls back to the semver named in the root
 * or workspace manifest, and only when every manifest that names it agrees.
 */
export function lockfileVersion(root: string, library: string): string | null {
  const { specs, importers } = manifestInfo(root, library);
  const reads = [
    readPin(path.join(root, 'package-lock.json'), (text) => fromNpm(text, library, importers)),
    readPin(path.join(root, 'yarn.lock'), (text) => fromYarn(text, library, specs)),
    readPin(path.join(root, 'pnpm-lock.yaml'), (text) => fromPnpm(text, library)),
  ];
  if (reads.some((read) => read.kind === 'ambiguous' || read.kind === 'unreadable')) return null;
  const pins = unique(reads.flatMap((read) => (read.kind === 'pin' ? [read.version] : [])));
  if (pins.length > 1) return null;
  if (pins.length === 1) return versionFromLockfile({ [library]: pins[0]! }, library);
  const fromManifest = sole(specs.map(semverInSpec).filter((v): v is string => v !== null));
  return fromManifest ? versionFromLockfile({ [library]: fromManifest }, library) : null;
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
    const fetched = fetchPinnedCommits(git, kase.base_commit, kase.merge_commit);
    const baseOk = fetched.baseOk;
    const mergeOk = fetched.mergeOk;
    line('base fetchable', baseOk, kase.base_commit);
    line('merge fetchable', mergeOk, kase.merge_commit);
    if (baseOk && mergeOk) {
      const parents = readMergeParents(git, kase.merge_commit);
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
