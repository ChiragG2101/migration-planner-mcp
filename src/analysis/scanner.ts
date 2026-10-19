// scan_repo's analysis: the bounded walk (walk.ts), then packages, versions,
// workspaces and lockfiles, with entrypoints, test setup and config from the
// per-ecosystem modules in packages/. All from files read through the path
// boundary. Deterministic: every list is sorted.
import { resolveInside } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';
import type { Dependency, Lockfile, Package, ScanLimits, Workspace } from '../schema/scan.js';
import {
  type DeclaredDep,
  type LockLookup,
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parseYarnLock,
} from './manifests/node.js';
import { normalizePyName, parsePackageListLock, parsePyproject, parseRequirements, pinnedVersion } from './manifests/python.js';
import { nodeEntrypoints, nodeTests, tsChain } from './packages/node.js';
import { pythonEntrypoints, pythonTests } from './packages/python.js';
import { baseOf, byName, dirOf, isAncestorOrSelf, shownDir, under, type Walk, walkRepo } from './walk.js';

export { DEFAULT_LIMITS, type Walk, type WalkedFile, walkRepo } from './walk.js';

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
