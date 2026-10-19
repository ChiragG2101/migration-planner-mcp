// scan_repo's analysis: a bounded walk of the repo, then packages, versions,
// entrypoints, test setup and config, all from files read through the path
// boundary. Deterministic: every list is sorted.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PermissionError } from '../security/errors.js';
import { isDenied } from '../security/denyList.js';
import { resolveInside } from '../security/pathBoundary.js';
import { listDir, readBytes, readText, statPath } from '../security/safeRead.js';
import type { Dependency, Entrypoint, Lockfile, Package, ScanLimits, Skipped, TestSetup, TsConfigInfo, Workspace } from '../schema/scan.js';
import {
  type DeclaredDep,
  type LockLookup,
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parseTsConfig,
  parseYarnLock,
} from './manifests/node.js';
import {
  djangoSettingsModule,
  normalizePyName,
  parsePackageListLock,
  parsePyproject,
  parseRequirements,
  pinnedVersion,
  pytestIniPythonFiles,
} from './manifests/python.js';

export const DEFAULT_LIMITS: ScanLimits = {
  max_files: 20_000,
  max_file_bytes: 8 * 1024 * 1024,
  max_total_bytes: 256 * 1024 * 1024,
};

export interface WalkedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Walk {
  files: WalkedFile[];
  skipped: Skipped[];
  bytes: number;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Walks the repo. An entry the boundary rejects or the deny list matches is
 * skipped and listed (path only), never read; the walk carries on.
 */
export function walkRepo(root: string, repoId: string, limits: ScanLimits): Walk {
  const files: WalkedFile[] = [];
  const skipped: Skipped[] = [];
  const seenDirs = new Set<string>();
  let bytes = 0;

  const visit = (dirRel: string): void => {
    const dir = resolveInside(root, dirRel || '.', repoId);
    if (seenDirs.has(dir.abs)) return;
    seenDirs.add(dir.abs);
    const entries = listDir(dir).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const shown = entry.isDirectory() ? `${rel}/` : rel;
      let sp;
      try {
        sp = resolveInside(root, rel, repoId);
      } catch (err) {
        if (err instanceof PermissionError && err.code === 'outside_root') {
          skipped.push({ path: shown, reason: 'outside_root' });
          continue;
        }
        throw err;
      }
      if (isDenied(sp)) {
        skipped.push({ path: shown, reason: 'denied' });
        continue;
      }
      let st;
      try {
        st = statPath(sp);
      } catch {
        skipped.push({ path: shown, reason: 'unreadable' });
        continue;
      }
      if (st.isDirectory()) {
        visit(rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (files.length >= limits.max_files) {
        skipped.push({ path: rel, reason: 'max_files' });
      } else if (st.size > limits.max_file_bytes) {
        skipped.push({ path: rel, reason: 'too_large' });
      } else if (bytes + st.size > limits.max_total_bytes) {
        skipped.push({ path: rel, reason: 'max_total_bytes' });
      } else {
        const content = readBytes(sp);
        bytes += content.length;
        files.push({ path: rel, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      }
    }
  };

  visit('');
  return { files, skipped: skipped.sort((a, b) => byName(a.path, b.path)), bytes };
}

const posix = path.posix;
const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);
const isAncestorOrSelf = (dir: string, of: string): boolean => dir === '' || of === dir || of.startsWith(`${dir}/`);
const shownDir = (dir: string): string => dir || '.';

/** A package-relative path from a manifest, normalised to the repo; null if it leaves the root. */
function inRepo(dir: string, value: string): string | null {
  const p = posix.normalize(under(dir, value.replace(/^\.\//, '')));
  return p.startsWith('..') || posix.isAbsolute(p) ? null : p.replace(/\/$/, '');
}

/** Workspace globs: `*` within a segment, `**` across segments, `!` negates. */
function matchesWorkspace(patterns: readonly string[], rel: string): boolean {
  let hit = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const glob = (neg ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '');
    const re = new RegExp(
      `^${glob
        .split('**')
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*')}$`,
    );
    if (re.test(rel)) hit = !neg;
  }
  return hit;
}

interface LockSource {
  path: string;
  dir: string;
  kind: Lockfile['kind'];
  lookup: LockLookup;
}

export interface Candidate {
  version: string;
  where: string;
}

/** A dependency plus every version a lockfile pins for it, before ingest picks one. */
export interface DepFacts extends Dependency {
  candidates: Candidate[];
}

export interface PackageFacts extends Omit<Package, 'dependencies'> {
  dependencies: DepFacts[];
}

export interface RepoFacts {
  walk: Walk;
  workspaces: Workspace[];
  packages: PackageFacts[];
  lockfiles: Lockfile[];
  unrecognised: string[];
  manifestErrors: { path: string; message: string }[];
}

const nodeLockKinds = new Set(['npm', 'pnpm', 'yarn']);
const pyLockKinds = new Set(['uv', 'poetry']);
const unrecognisedNames = new Set(['setup.py', 'setup.cfg', 'Pipfile', 'Pipfile.lock']);
const isRequirementsFile = (rel: string): boolean =>
  /^requirements[^/]*\.txt$/.test(baseOf(rel)) || (baseOf(dirOf(rel)) === 'requirements' && rel.endsWith('.txt'));

const jestDefaultGlobs = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];
const vitestDefaultGlobs = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const playwrightDefaultGlobs = ['**/*.@(spec|test).?(c|m)[jt]s?(x)'];
const pytestDefaultGlobs = ['test_*.py', '*_test.py'];
const configExts = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'json'];

export function analyzeRepo(root: string, repoId: string, limits: ScanLimits): RepoFacts {
  const walk = walkRepo(root, repoId, limits);
  const fileSet = new Set(walk.files.map((f) => f.path));
  const manifestErrors: { path: string; message: string }[] = [];
  const read = (rel: string): string => readText(resolveInside(root, rel, repoId));
  const tryParse = <T>(rel: string, parse: (text: string) => T): T | null => {
    try {
      return parse(read(rel));
    } catch (err) {
      manifestErrors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const sorted = [...fileSet].sort(byName);
  const named = (name: string): string[] => sorted.filter((f) => baseOf(f) === name);
  const exists = (rel: string): boolean => fileSet.has(rel);

  // Lockfiles.
  const lockSources: LockSource[] = [];
  const addLock = (rel: string, kind: Lockfile['kind'], parse: (t: string) => LockLookup): void => {
    const lookup = tryParse(rel, parse);
    if (lookup) lockSources.push({ path: rel, dir: dirOf(rel), kind, lookup });
  };
  for (const f of named('package-lock.json')) addLock(f, 'npm', parsePackageLock);
  for (const f of named('pnpm-lock.yaml')) addLock(f, 'pnpm', parsePnpmLock);
  for (const f of named('yarn.lock')) addLock(f, 'yarn', parseYarnLock);
  for (const f of named('uv.lock')) addLock(f, 'uv', parsePackageListLock);
  for (const f of named('poetry.lock')) addLock(f, 'poetry', parsePackageListLock);
  const requirementFiles = sorted.filter(isRequirementsFile);

  const lockCandidates = (kinds: Set<string>, pkgDir: string, name: string, spec: string | null): Candidate[] => {
    for (let d = pkgDir; ; d = dirOf(d)) {
      const locks = lockSources.filter((l) => kinds.has(l.kind) && l.dir === d);
      if (locks.length) {
        const importer = d === pkgDir ? '' : pkgDir.slice(d ? d.length + 1 : 0);
        return locks.flatMap((l) => l.lookup(name, importer, spec).map((version) => ({ version, where: l.path })));
      }
      if (d === '') return [];
    }
  };

  const toDepFacts = (d: DeclaredDep, declaredIn: string, candidates: Candidate[]): DepFacts => {
    const versions = [...new Set(candidates.map((c) => c.version))];
    return {
      name: d.name,
      kind: d.kind,
      declared: d.spec,
      declared_in: declaredIn,
      resolved: versions.length === 1 ? versions[0]! : null,
      resolved_from: [...new Set(candidates.map((c) => c.where))].sort(byName),
      candidates,
    };
  };

  const workspaces: Workspace[] = [];
  const packages: PackageFacts[] = [];

  // Node packages: every package.json outside node_modules (which the deny list keeps out of the walk).
  const nodePkgs = named('package.json')
    .map((rel) => ({ rel, dir: dirOf(rel), pkg: tryParse(rel, parsePackageJson) }))
    .filter((p): p is { rel: string; dir: string; pkg: NonNullable<typeof p.pkg> } => p.pkg !== null);
  for (const { rel, dir, pkg } of nodePkgs) {
    if (pkg.workspaces.length) {
      workspaces.push({ kind: exists(under(dir, 'yarn.lock')) ? 'yarn' : 'npm', manifest: rel, patterns: pkg.workspaces });
    }
  }
  for (const f of named('pnpm-workspace.yaml')) {
    const patterns = tryParse(f, parsePnpmWorkspace);
    if (patterns) workspaces.push({ kind: 'pnpm', manifest: f, patterns });
  }

  const isMember = (dir: string, kinds: string[]): boolean =>
    workspaces.some((w) => {
      const wsDir = dirOf(w.manifest);
      if (!kinds.includes(w.kind) || dir === wsDir || !isAncestorOrSelf(wsDir, dir)) return false;
      return matchesWorkspace(w.patterns, wsDir ? dir.slice(wsDir.length + 1) : dir);
    });

  for (const { rel, dir, pkg } of nodePkgs) {
    const deps = pkg.deps.map((d) => toDepFacts(d, rel, lockCandidates(nodeLockKinds, dir, d.name, d.spec)));
    const depNames = new Set(pkg.deps.map((d) => d.name));
    packages.push({
      path: shownDir(dir),
      ecosystem: 'node',
      name: pkg.name,
      manifests: [rel],
      workspace_member: isMember(dir, ['npm', 'yarn', 'pnpm']),
      dependencies: deps,
      entrypoints: nodeEntrypoints(dir, rel, pkg, depNames, sorted, exists),
      tests: nodeTests(dir, pkg, depNames, exists),
      tsconfig: exists(under(dir, 'tsconfig.json'))
        ? tsChain(under(dir, 'tsconfig.json'), exists, read, (rel, message) => manifestErrors.push({ path: rel, message }))
        : null,
      python_tools: null,
    });
  }

  // Python packages: folders with a pyproject.toml or requirements files, plus a manage.py with neither above it.
  const pyDirs = new Set<string>(named('pyproject.toml').map(dirOf));
  const reqDir = (rel: string): string => (baseOf(dirOf(rel)) === 'requirements' ? dirOf(dirOf(rel)) : dirOf(rel));
  for (const f of requirementFiles) pyDirs.add(reqDir(f));
  const nearestPy = (rel: string): string | null => {
    let best: string | null = null;
    for (const d of pyDirs) if (isAncestorOrSelf(d, rel) && (best === null || d.length > best.length)) best = d;
    return best;
  };
  for (const f of named('manage.py')) if (nearestPy(f) === null) pyDirs.add(dirOf(f));

  for (const dir of [...pyDirs].sort(byName)) {
    const pyprojectRel = under(dir, 'pyproject.toml');
    const pyproject = exists(pyprojectRel) ? tryParse(pyprojectRel, parsePyproject) : null;
    const reqs = requirementFiles.filter((f) => reqDir(f) === dir);
    const reqDeps = reqs.map((f) => ({
      file: f,
      deps: tryParse(f, (t) => parseRequirements(t, /dev|test|lint|ci/i.test(baseOf(f)) ? 'dev' : 'prod')) ?? [],
    }));
    const pins = (name: string): Candidate[] =>
      reqDeps.flatMap(({ file, deps }) =>
        deps
          .filter((d) => normalizePyName(d.name) === normalizePyName(name))
          .map((d) => pinnedVersion(d.spec))
          .filter((v): v is string => v !== null)
          .map((version) => ({ version, where: file })),
      );
    const candidatesFor = (name: string, spec: string | null): Candidate[] => [
      ...lockCandidates(pyLockKinds, dir, name, spec),
      ...pins(name),
    ];
    const deps: DepFacts[] = [
      ...(pyproject?.deps ?? []).map((d) => toDepFacts(d, pyprojectRel, candidatesFor(d.name, d.spec))),
      ...reqDeps.flatMap(({ file, deps: ds }) => ds.map((d) => toDepFacts(d, file, candidatesFor(d.name, d.spec)))),
    ];
    if (pyproject?.uvWorkspaceMembers) workspaces.push({ kind: 'uv', manifest: pyprojectRel, patterns: pyproject.uvWorkspaceMembers });
    const ownFiles = sorted.filter((f) => nearestPy(f) === dir);
    const depNames = new Set(deps.map((d) => normalizePyName(d.name)));
    packages.push({
      path: shownDir(dir),
      ecosystem: 'python',
      name: pyproject?.name ?? null,
      manifests: [...(pyproject ? [pyprojectRel] : []), ...reqs].sort(byName),
      workspace_member: false,
      dependencies: deps,
      entrypoints: pythonEntrypoints(dir, pyproject?.scripts ?? [], ownFiles, exists, read),
      tests: pythonTests(dir, pyproject?.tools ?? {}, pyproject?.pytestPythonFiles ?? null, depNames, ownFiles, exists, read),
      tsconfig: null,
      python_tools: pyproject ? pyproject.tools : null,
    });
  }
  for (const p of packages) {
    if (p.ecosystem === 'python') {
      const dir = p.path === '.' ? '' : p.path;
      p.workspace_member = isMember(dir, ['uv']);
    }
  }

  const sortDeps = (a: DepFacts, b: DepFacts): number =>
    byName(a.declared_in, b.declared_in) || byName(a.kind, b.kind) || byName(a.name, b.name);
  for (const p of packages) p.dependencies.sort(sortDeps);
  packages.sort((a, b) => byName(a.path, b.path) || byName(a.ecosystem, b.ecosystem));

  const lockfiles: Lockfile[] = [
    ...lockSources.map((l) => ({ path: l.path, kind: l.kind })),
    ...requirementFiles.map((f) => ({ path: f, kind: 'requirements' as const })),
  ].sort((a, b) => byName(a.path, b.path));

  return {
    walk,
    workspaces: workspaces.sort((a, b) => byName(a.manifest, b.manifest)),
    packages,
    lockfiles,
    // A setup.py inside a Python package (an __init__.py beside it) is a module, such as a Django command, not a manifest.
    unrecognised: sorted.filter(
      (f) => unrecognisedNames.has(baseOf(f)) && !(baseOf(f) === 'setup.py' && exists(under(dirOf(f), '__init__.py'))),
    ),
    manifestErrors: manifestErrors.sort((a, b) => byName(a.path, b.path)),
  };
}

function sortEntrypoints(list: Entrypoint[]): Entrypoint[] {
  return list.sort((a, b) => byName(a.kind, b.kind) || byName(a.path ?? '', b.path ?? '') || byName(a.value ?? '', b.value ?? ''));
}

function nodeEntrypoints(
  dir: string,
  manifest: string,
  pkg: ReturnType<typeof parsePackageJson>,
  depNames: Set<string>,
  files: readonly string[],
  exists: (rel: string) => boolean,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  const declared = (kind: string, value: string, field: string): void => {
    out.push({ kind, path: inRepo(dir, value), value, source: `${manifest}#${field}`, confidence: 'exact' });
  };
  if (pkg.main) declared('main', pkg.main, 'main');
  if (pkg.module) declared('module', pkg.module, 'module');
  for (const e of pkg.exports) declared('exports', e.value, e.key ? `exports.${e.key}` : 'exports');
  for (const b of pkg.bin) declared('bin', b.value, b.name ? `bin.${b.name}` : 'bin');

  const nextConfigs = ['js', 'mjs', 'cjs', 'ts', 'mts'].map((e) => under(dir, `next.config.${e}`)).filter(exists);
  for (const c of nextConfigs) out.push({ kind: 'next_config', path: c, value: null, source: c, confidence: 'exact' });
  // App and pages folders count as Next.js markers only in a package that uses Next.js.
  if (depNames.has('next') || nextConfigs.length) {
    for (const prefix of [dir, under(dir, 'src')]) {
      const app = under(prefix, 'app');
      const appFile = files.find((f) => f.startsWith(`${app}/`) && /^(page|layout|route)\.(jsx?|tsx?|mdx?)$/.test(baseOf(f)));
      if (appFile) out.push({ kind: 'next_app_router', path: app, value: null, source: appFile, confidence: 'exact' });
      const pages = under(prefix, 'pages');
      const pageFile = files.find((f) => f.startsWith(`${pages}/`) && /\.(jsx?|tsx?|mdx?)$/.test(f));
      if (pageFile) out.push({ kind: 'next_pages_router', path: pages, value: null, source: pageFile, confidence: 'exact' });
    }
  }
  for (const prefix of [dir, under(dir, 'src')]) {
    for (const ext of ['js', 'mjs', 'cjs', 'ts', 'mts']) {
      const f = under(prefix, `server.${ext}`);
      if (exists(f)) out.push({ kind: 'server', path: f, value: null, source: 'file name', confidence: 'heuristic' });
    }
  }
  return sortEntrypoints(out);
}

function nodeTests(dir: string, pkg: ReturnType<typeof parsePackageJson>, depNames: Set<string>, exists: (rel: string) => boolean): TestSetup {
  const runners: TestSetup['runners'] = [];
  const globs = new Set<string>();
  const configs = (stem: string): string[] => configExts.map((e) => under(dir, `${stem}.${e}`)).filter(exists);
  const detect = (name: string, deps: string[], configStems: string[], extra: string[], defaults: readonly string[]): void => {
    const evidence = [...deps.filter((d) => depNames.has(d)).map((d) => `dependency ${d}`), ...configStems.flatMap(configs), ...extra];
    if (evidence.length) {
      runners.push({ name, evidence });
      defaults.forEach((g) => globs.add(g));
    }
  };
  detect('jest', ['jest'], ['jest.config'], pkg.jestTestMatch ? [`${under(dir, 'package.json')}#jest`] : [], pkg.jestTestMatch ?? jestDefaultGlobs);
  detect('vitest', ['vitest'], ['vitest.config', 'vitest.workspace'], [], vitestDefaultGlobs);
  detect('playwright', ['@playwright/test', 'playwright'], ['playwright.config'], [], playwrightDefaultGlobs);
  return { runners, globs: [...globs].sort(byName), test_script: pkg.scripts.test ?? null };
}

/** Finds the file for a dotted module, trying each base folder; null when none exists. */
function moduleFile(module: string, bases: readonly string[], exists: (rel: string) => boolean): string | null {
  const rel = module.replace(/\./g, '/');
  for (const base of bases) {
    for (const cand of [under(base, `${rel}.py`), under(base, `${rel}/__init__.py`)]) if (exists(cand)) return cand;
  }
  return null;
}

function pythonEntrypoints(
  dir: string,
  scripts: readonly { name: string; value: string; source: string }[],
  ownFiles: readonly string[],
  exists: (rel: string) => boolean,
  read: (rel: string) => string,
): Entrypoint[] {
  const out: Entrypoint[] = [];
  const bases = [dir, under(dir, 'src')];
  for (const s of scripts) {
    const module = s.value.split(':')[0]!.trim();
    out.push({ kind: 'script', path: moduleFile(module, bases, exists), value: `${s.name} = ${s.value}`, source: s.source, confidence: 'exact' });
  }
  const settingsSeen = new Set<string>();
  for (const f of ownFiles) {
    const base = baseOf(f);
    if (base !== 'manage.py' && base !== 'wsgi.py' && base !== 'asgi.py') continue;
    if (base === 'manage.py') out.push({ kind: 'django_manage', path: f, value: null, source: f, confidence: 'exact' });
    else out.push({ kind: base === 'wsgi.py' ? 'wsgi' : 'asgi', path: f, value: null, source: 'file name', confidence: 'heuristic' });
    let text: string;
    try {
      text = read(f);
    } catch {
      continue;
    }
    const module = djangoSettingsModule(text);
    if (module && !settingsSeen.has(module)) {
      settingsSeen.add(module);
      const manageDir = base === 'manage.py' ? dirOf(f) : dirOf(dirOf(f));
      out.push({
        kind: 'django_settings',
        path: moduleFile(module, [manageDir, ...bases], exists),
        value: module,
        source: f,
        confidence: 'heuristic',
      });
    }
  }
  return sortEntrypoints(out);
}

function pythonTests(
  dir: string,
  tools: Record<string, unknown>,
  pyprojectPythonFiles: string[] | null,
  depNames: Set<string>,
  ownFiles: readonly string[],
  exists: (rel: string) => boolean,
  read: (rel: string) => string,
): TestSetup {
  const runners: TestSetup['runners'] = [];
  const globs = new Set<string>();
  const pytestIni = under(dir, 'pytest.ini');
  const iniFiles = exists(pytestIni) ? pytestIniPythonFiles(read(pytestIni)) : null;
  const pytestEvidence = [
    ...(depNames.has('pytest') ? ['dependency pytest'] : []),
    ...(exists(pytestIni) ? [pytestIni] : []),
    ...(exists(under(dir, 'conftest.py')) ? [under(dir, 'conftest.py')] : []),
    ...('pytest' in tools ? [`${under(dir, 'pyproject.toml')}#tool.pytest`] : []),
  ];
  if (pytestEvidence.length) {
    runners.push({ name: 'pytest', evidence: pytestEvidence });
    (iniFiles ?? pyprojectPythonFiles ?? pytestDefaultGlobs).forEach((g) => globs.add(g));
  }
  if (depNames.has('pytest-django')) runners.push({ name: 'pytest-django', evidence: ['dependency pytest-django'] });
  const manage = ownFiles.find((f) => baseOf(f) === 'manage.py');
  if (manage && depNames.has('django')) {
    runners.push({ name: 'django', evidence: [manage, 'dependency django'] });
    globs.add('test*.py');
  }
  return { runners, globs: [...globs].sort(byName), test_script: null };
}

function tsChain(
  start: string,
  exists: (rel: string) => boolean,
  read: (rel: string) => string,
  onError: (rel: string, message: string) => void,
): TsConfigInfo {
  const chain: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  type Merged = { module: string | null; target: string | null; paths: Record<string, string[]> | null };
  const load = (rel: string): Merged => {
    seen.add(rel);
    chain.push(rel);
    let cfg;
    try {
      cfg = parseTsConfig(read(rel));
    } catch (err) {
      onError(rel, err instanceof Error ? err.message : String(err));
      throw err;
    }
    let merged: Merged = { module: null, target: null, paths: null };
    for (const ext of cfg.extends) {
      let base = ext.startsWith('.') ? posix.normalize(under(dirOf(rel), ext)) : null;
      if (base && !base.endsWith('.json')) base += '.json';
      if (!base || base.startsWith('..') || !exists(base) || seen.has(base)) {
        unresolved.push(ext);
        continue;
      }
      try {
        const parent = load(base);
        merged = { module: parent.module ?? merged.module, target: parent.target ?? merged.target, paths: parent.paths ?? merged.paths };
      } catch {
        unresolved.push(ext);
      }
    }
    return { module: cfg.module ?? merged.module, target: cfg.target ?? merged.target, paths: cfg.paths ?? merged.paths };
  };
  let merged: Merged = { module: null, target: null, paths: null };
  try {
    merged = load(start);
  } catch {
    // Reported through onError; the chain stays as far as it got.
  }
  return { chain, unresolved_extends: unresolved, module: merged.module, target: merged.target, paths: merged.paths ?? {} };
}
