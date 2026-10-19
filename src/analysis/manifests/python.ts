// Python manifests and lockfiles: pyproject.toml (PEP 621, Poetry, uv
// workspaces), requirements*.txt, uv.lock and poetry.lock. Pure parsers over text.
import { parse as parseToml } from 'smol-toml';
import type { DeclaredDep, DepKind, LockLookup } from './node.js';

type Table = Record<string, unknown>;
const isObj = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** PEP 503 name normalisation: case-insensitive, runs of `-`, `_` and `.` are equal. */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Splits a PEP 508 requirement into name and version spec (extras and markers dropped). */
export function parseRequirement(req: string): { name: string; spec: string | null } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:\(([^)]*)\)|([^;]*))?\s*(?:;.*)?$/.exec(req);
  if (!m) return null;
  const spec = (m[2] ?? m[3] ?? '').trim();
  return { name: m[1]!, spec: spec || null };
}

/** The exact version an `==` (or `===`) spec pins, or null. */
export function pinnedVersion(spec: string | null): string | null {
  const m = spec ? /^===?\s*([A-Za-z0-9.+!_-]+)$/.exec(spec.trim()) : null;
  return m && !m[1]!.includes('*') ? m[1]! : null;
}

export interface ScriptEntry {
  name: string;
  value: string;
  source: string;
}

export interface Pyproject {
  name: string | null;
  deps: DeclaredDep[];
  scripts: ScriptEntry[];
  uvWorkspaceMembers: string[] | null;
  tools: Record<string, unknown>;
  pytestPythonFiles: string[] | null;
}

// pyproject [tool.*] sections relevant to tests and typing.
const toolSections = ['pytest', 'mypy', 'pyright', 'django-stubs', 'coverage'];

function poetryDeps(table: unknown, kind: DepKind): DeclaredDep[] {
  if (!isObj(table)) return [];
  return Object.entries(table)
    .filter(([name]) => name.toLowerCase() !== 'python')
    .map(([name, v]) => ({
      name,
      kind,
      spec: typeof v === 'string' ? v : isObj(v) && typeof v.version === 'string' ? v.version : null,
    }));
}

export function parsePyproject(text: string): Pyproject {
  const doc = parseToml(text) as Table;
  const project = isObj(doc.project) ? doc.project : {};
  const tool = isObj(doc.tool) ? doc.tool : {};
  const poetry = isObj(tool.poetry) ? tool.poetry : {};
  const deps: DeclaredDep[] = [];
  const pep508 = (list: unknown, kind: DepKind): void => {
    for (const req of strings(list)) {
      const r = parseRequirement(req);
      if (r) deps.push({ name: r.name, kind, spec: r.spec });
    }
  };
  pep508(project.dependencies, 'prod');
  if (isObj(project['optional-dependencies'])) for (const list of Object.values(project['optional-dependencies'])) pep508(list, 'optional');
  if (isObj(doc['dependency-groups'])) for (const list of Object.values(doc['dependency-groups'])) pep508(list, 'dev');
  deps.push(...poetryDeps(poetry.dependencies, 'prod'), ...poetryDeps(poetry['dev-dependencies'], 'dev'));
  if (isObj(poetry.group)) for (const g of Object.values(poetry.group)) if (isObj(g)) deps.push(...poetryDeps(g.dependencies, 'dev'));

  const scripts: ScriptEntry[] = [];
  const addScripts = (table: unknown, source: string): void => {
    if (isObj(table)) for (const [name, v] of Object.entries(table)) if (typeof v === 'string') scripts.push({ name, value: v, source });
  };
  addScripts(project.scripts, 'pyproject.toml#project.scripts');
  addScripts(poetry.scripts, 'pyproject.toml#tool.poetry.scripts');

  const uv = isObj(tool.uv) ? tool.uv : {};
  const uvWs = isObj(uv.workspace) ? uv.workspace : null;

  const tools: Record<string, unknown> = {};
  for (const key of toolSections) if (key in tool) tools[key] = JSON.parse(JSON.stringify(tool[key])) as unknown;

  const pytest = isObj(tool.pytest) && isObj(tool.pytest.ini_options) ? tool.pytest.ini_options : null;
  const pf = pytest?.python_files;
  return {
    name: typeof project.name === 'string' ? project.name : typeof poetry.name === 'string' ? poetry.name : null,
    deps,
    scripts,
    uvWorkspaceMembers: uvWs ? strings(uvWs.members) : null,
    tools,
    pytestPythonFiles: typeof pf === 'string' ? pf.split(/\s+/).filter(Boolean) : Array.isArray(pf) ? strings(pf) : null,
  };
}

/** requirements*.txt: one requirement per line; options, includes, URLs and editables are not dependencies we can name. */
export function parseRequirements(text: string, kind: DepKind): DeclaredDep[] {
  const deps: DeclaredDep[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-') || /^[a-z+]+:\/\//i.test(line) || line.includes(' @ ')) continue;
    const r = parseRequirement(line);
    if (r) deps.push({ name: r.name, kind, spec: r.spec });
  }
  return deps;
}

/** uv.lock and poetry.lock both list `[[package]]` with name and version. */
export function parsePackageListLock(text: string): LockLookup {
  const doc = parseToml(text) as Table;
  const byName = new Map<string, Set<string>>();
  const list = Array.isArray(doc.package) ? doc.package : [];
  for (const p of list) {
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.version !== 'string') continue;
    const n = normalizePyName(p.name);
    if (!byName.has(n)) byName.set(n, new Set());
    byName.get(n)!.add(p.version);
  }
  return (name) => [...(byName.get(normalizePyName(name)) ?? [])].sort();
}

/** pytest.ini: the `python_files` option, if set. */
export function pytestIniPythonFiles(text: string): string[] | null {
  const m = /^\s*python_files\s*=\s*(.+)$/m.exec(text);
  return m ? m[1]!.trim().split(/\s+/) : null;
}

/** The settings module named by DJANGO_SETTINGS_MODULE in manage.py, wsgi.py or asgi.py. */
export function djangoSettingsModule(text: string): string | null {
  const m = /DJANGO_SETTINGS_MODULE['"]?\]?\s*[,:=]\s*['"]([A-Za-z_][\w.]*)['"]/.exec(text);
  return m ? m[1]! : null;
}
