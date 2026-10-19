// Node manifests and lockfiles: package.json, package-lock.json, pnpm-lock.yaml,
// yarn.lock (v1 and berry), pnpm-workspace.yaml and tsconfig (JSONC). Pure
// parsers over text; reading goes through safeRead in the scanner.
import { parse as parseYaml } from 'yaml';

export type DepKind = 'prod' | 'dev' | 'peer' | 'optional';

export interface DeclaredDep {
  name: string;
  kind: DepKind;
  spec: string | null;
}

export interface PackageJson {
  name: string | null;
  deps: DeclaredDep[];
  scripts: Record<string, string>;
  main: string | null;
  module: string | null;
  exports: { key: string; value: string }[];
  bin: { name: string; value: string }[];
  workspaces: string[];
  jestTestMatch: string[] | null;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const depFields: [string, DepKind][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

export function parsePackageJson(text: string): PackageJson {
  const pkg = JSON.parse(text) as unknown;
  if (!isObj(pkg)) throw new Error('package.json is not an object');
  const deps: DeclaredDep[] = [];
  for (const [field, kind] of depFields) {
    const table = pkg[field];
    if (isObj(table)) for (const [name, spec] of Object.entries(table)) deps.push({ name, kind, spec: str(spec) });
  }
  const exportsList: { key: string; value: string }[] = [];
  const walkExports = (v: unknown, key: string): void => {
    if (typeof v === 'string') exportsList.push({ key, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walkExports(x, `${key}[${i}]`));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) walkExports(x, key ? `${key}.${k}` : k);
  };
  walkExports(pkg.exports, '');
  const name = str(pkg.name);
  const bin: { name: string; value: string }[] = [];
  if (typeof pkg.bin === 'string') bin.push({ name: name ?? '', value: pkg.bin });
  else if (isObj(pkg.bin)) for (const [k, v] of Object.entries(pkg.bin)) if (typeof v === 'string') bin.push({ name: k, value: v });
  const ws = pkg.workspaces;
  const jest = pkg.jest;
  return {
    name,
    deps,
    scripts: isObj(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {},
    main: str(pkg.main),
    module: str(pkg.module),
    exports: exportsList,
    bin,
    workspaces: Array.isArray(ws) ? strings(ws) : isObj(ws) ? strings(ws.packages) : [],
    jestTestMatch: isObj(jest) && Array.isArray(jest.testMatch) ? strings(jest.testMatch) : null,
  };
}

/** Finds the versions a lockfile pins for `name` as used by the package at `importer` (relative to the lockfile's folder, '' for the same folder). */
export type LockLookup = (name: string, importer: string, spec: string | null) => string[];

const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);

export function parsePackageLock(text: string): LockLookup {
  const lock = JSON.parse(text) as unknown;
  if (!isObj(lock)) throw new Error('package-lock.json is not an object');
  const packages = isObj(lock.packages) ? lock.packages : null;
  const v1 = isObj(lock.dependencies) ? lock.dependencies : null;
  return (name, importer) => {
    if (packages) {
      for (const key of [join(importer, `node_modules/${name}`), `node_modules/${name}`]) {
        const entry = packages[key];
        if (isObj(entry) && typeof entry.version === 'string' && !entry.link) return [entry.version];
      }
      return [];
    }
    const entry = v1?.[name];
    return isObj(entry) && typeof entry.version === 'string' ? [entry.version] : [];
  };
}

function cleanPnpmVersion(v: string): string | null {
  if (v.startsWith('link:') || v.startsWith('file:') || v.startsWith('workspace:')) return null;
  // Strip peer suffixes: "14.2.3(react@18.3.1)" (v6+) and "14.2.3_react@18.3.1" (v5).
  return v.split('(')[0]!.split('_')[0]!.trim() || null;
}

export function parsePnpmLock(text: string): LockLookup {
  const lock = parseYaml(text) as unknown;
  if (!isObj(lock)) throw new Error('pnpm-lock.yaml is not a mapping');
  const importers = isObj(lock.importers) ? lock.importers : null;
  return (name, importer) => {
    const scope = importers ? importers[importer || '.'] : lock;
    if (!isObj(scope)) return [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const table = scope[field];
      if (!isObj(table)) continue;
      const entry = table[name];
      const raw = typeof entry === 'string' ? entry : isObj(entry) ? str(entry.version) : null;
      const v = raw ? cleanPnpmVersion(raw) : null;
      if (v) return [v];
    }
    return [];
  };
}

/** yarn.lock, both the v1 format and berry (YAML-like) share the "spec, spec:" header and an indented version line. */
export function parseYarnLock(text: string): LockLookup {
  const bySpec = new Map<string, string>();
  const byName = new Map<string, Set<string>>();
  let specs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line) && line.endsWith(':')) {
      specs = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((s) => s.trim().replace(/^"|"$/g, ''));
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m && specs.length) {
      for (const spec of specs) {
        bySpec.set(spec, m[1]!);
        const at = spec.lastIndexOf('@');
        if (at > 0) {
          const name = spec.slice(0, at);
          if (!byName.has(name)) byName.set(name, new Set());
          byName.get(name)!.add(m[1]!);
        }
      }
      specs = [];
    }
  }
  return (name, _importer, spec) => {
    if (spec) {
      const exact = bySpec.get(`${name}@${spec}`) ?? bySpec.get(`${name}@npm:${spec}`);
      if (exact) return [exact];
    }
    return [...(byName.get(name) ?? [])].sort();
  };
}

export function parsePnpmWorkspace(text: string): string[] {
  const doc = parseYaml(text) as unknown;
  return isObj(doc) ? strings(doc.packages) : [];
}

/** JSON with comments and trailing commas, as tsconfig allows. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export interface TsConfigFile {
  extends: string[];
  module: string | null;
  target: string | null;
  paths: Record<string, string[]> | null;
}

export function parseTsConfig(text: string): TsConfigFile {
  const doc = parseJsonc(text);
  if (!isObj(doc)) throw new Error('tsconfig is not an object');
  const opts = isObj(doc.compilerOptions) ? doc.compilerOptions : {};
  const paths = isObj(opts.paths)
    ? Object.fromEntries(Object.entries(opts.paths).map(([k, v]) => [k, strings(v)]))
    : null;
  return {
    extends: typeof doc.extends === 'string' ? [doc.extends] : strings(doc.extends),
    module: str(opts.module),
    target: str(opts.target),
    paths,
  };
}

export interface PeerEntry {
  name: string;
  version: string;
  /** The text to find the entry's line by in the lockfile. */
  key: string;
  peers: Record<string, string>;
  optional: string[];
}

/**
 * The peer ranges a lockfile records for its packages. Returns null for a
 * format that records none (yarn v1, npm lockfile v1), so the caller reports
 * that peer conflicts could not be checked rather than finding none.
 */
export function parsePeerRanges(kind: 'npm' | 'pnpm' | 'yarn', text: string): PeerEntry[] | null {
  const out: PeerEntry[] = [];
  const peersOf = (entry: Record<string, unknown>): { peers: Record<string, string>; optional: string[] } => {
    const peers: Record<string, string> = {};
    if (isObj(entry.peerDependencies)) for (const [k, v] of Object.entries(entry.peerDependencies)) if (typeof v === 'string') peers[k] = v;
    const meta = isObj(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
    const optional = Object.entries(meta)
      .filter(([, m]) => isObj(m) && m.optional === true)
      .map(([k]) => k);
    return { peers, optional };
  };
  if (kind === 'npm') {
    const lock = JSON.parse(text) as unknown;
    if (!isObj(lock) || !isObj(lock.packages)) return null;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || !isObj(entry) || typeof entry.version !== 'string') continue;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ name, version: entry.version, key: `"${key}"`, ...peersOf(entry) });
    }
    return out;
  }
  if (kind === 'pnpm') {
    const lock = parseYaml(text) as unknown;
    if (!isObj(lock) || !isObj(lock.packages)) return null;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!isObj(entry)) continue;
      // "/next@14.2.3" (v6), "next@14.2.3" (v9), possibly with a "(peer@x)" suffix.
      const bare = key.replace(/^\//, '').split('(')[0]!;
      const at = bare.lastIndexOf('@');
      if (at <= 0) continue;
      out.push({ name: bare.slice(0, at), version: bare.slice(at + 1), key, ...peersOf(entry) });
    }
    return out;
  }
  // yarn: only berry (with __metadata) records peer ranges.
  if (!/^__metadata:/m.test(text)) return null;
  const lock = parseYaml(text) as unknown;
  if (!isObj(lock)) return null;
  for (const [key, entry] of Object.entries(lock)) {
    if (key === '__metadata' || !isObj(entry) || typeof entry.version !== 'string') continue;
    const first = key.split(',')[0]!.trim();
    const at = first.lastIndexOf('@');
    if (at <= 0) continue;
    out.push({ name: first.slice(0, at), version: entry.version, key: first, ...peersOf(entry) });
  }
  return out;
}
