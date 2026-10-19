// Python package facts for scan_repo: entrypoints (scripts, manage.py, Django
// settings) and test setup, from files already read through the path boundary.
import type { Entrypoint, TestSetup } from '../../schema/scan.js';
import { djangoSettingsModule, pytestIniPythonFiles } from '../manifests/python.js';
import { baseOf, byName, dirOf, sortEntrypoints, under } from '../walk.js';

const pytestDefaultGlobs = ['test_*.py', '*_test.py'];

/** Finds the file for a dotted module, trying each base folder; null when none exists. */
export function moduleFile(module: string, bases: readonly string[], exists: (rel: string) => boolean): string | null {
  const rel = module.replace(/\./g, '/');
  for (const base of bases) {
    for (const cand of [under(base, `${rel}.py`), under(base, `${rel}/__init__.py`)]) if (exists(cand)) return cand;
  }
  return null;
}

export function pythonEntrypoints(
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

export function pythonTests(
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
