// scan_repo analysis: workspaces, Django settings detection, unrecognised
// manifests, manifest errors and the size-limit skip list.
import { describe, expect, it } from 'vitest';
import { analyzeRepo, DEFAULT_LIMITS, walkRepo } from '../../src/analysis/scanner.js';
import { djangoSettingsModule } from '../../src/analysis/manifests/python.js';
import { tmpDir, writeTree } from '../helpers.js';

const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('workspaces', () => {
  it('npm workspaces: members found, versions resolved per importer', () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': pkg({ name: 'mono', private: true, workspaces: ['apps/*', '!apps/legacy'] }),
      'apps/web/package.json': pkg({ name: 'web', dependencies: { next: '^14.2.0' } }),
      'apps/legacy/package.json': pkg({ name: 'legacy', dependencies: { next: '^13.0.0' } }),
      'tools/x/package.json': pkg({ name: 'x' }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/next': { version: '14.2.35' }, 'apps/legacy/node_modules/next': { version: '13.5.6' } },
      }),
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.workspaces).toEqual([{ kind: 'npm', manifest: 'package.json', patterns: ['apps/*', '!apps/legacy'] }]);
    const byPath = Object.fromEntries(facts.packages.map((p) => [p.path, p]));
    expect(byPath['apps/web']!.workspace_member).toBe(true);
    expect(byPath['apps/legacy']!.workspace_member).toBe(false);
    expect(byPath['tools/x']!.workspace_member).toBe(false);
    expect(byPath['.']!.workspace_member).toBe(false);
    expect(byPath['apps/web']!.dependencies[0]!.resolved).toBe('14.2.35');
    expect(byPath['apps/legacy']!.dependencies[0]!.resolved).toBe('13.5.6');
  });

  it('yarn workspaces are labelled yarn when a yarn.lock sits beside them', () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': pkg({ workspaces: { packages: ['packages/**'] } }),
      'packages/a/b/package.json': pkg({ name: 'ab', dependencies: { next: '^14.2.0' } }),
      'yarn.lock': 'next@^14.2.0:\n  version "14.2.35"\n',
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.workspaces[0]!.kind).toBe('yarn');
    const ab = facts.packages.find((p) => p.path === 'packages/a/b')!;
    expect(ab.workspace_member).toBe(true);
    expect(ab.dependencies[0]!.resolved).toBe('14.2.35');
  });

  it('pnpm-workspace.yaml', () => {
    const root = tmpDir();
    writeTree(root, {
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'package.json': pkg({ name: 'root' }),
      'apps/web/package.json': pkg({ name: 'web', dependencies: { next: '^15.0.0' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies:\n      next:\n        specifier: ^15.0.0\n        version: 15.1.0\n",
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.workspaces).toEqual([{ kind: 'pnpm', manifest: 'pnpm-workspace.yaml', patterns: ['apps/*'] }]);
    const web = facts.packages.find((p) => p.path === 'apps/web')!;
    expect(web.workspace_member).toBe(true);
    expect(web.dependencies[0]!.resolved).toBe('15.1.0');
  });

  it('uv workspaces and several pyproject.toml files, each its own package', () => {
    const root = tmpDir();
    writeTree(root, {
      'pyproject.toml': '[project]\nname = "root"\ndependencies = []\n[tool.uv.workspace]\nmembers = ["libs/*"]\n',
      'libs/core/pyproject.toml': '[project]\nname = "core"\ndependencies = ["Django>=4.2"]\n',
      'services/api/pyproject.toml': '[project]\nname = "api"\ndependencies = ["django>=4.2"]\n',
      'uv.lock': 'version = 1\n[[package]]\nname = "django"\nversion = "4.2.30"\n',
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.workspaces).toEqual([{ kind: 'uv', manifest: 'pyproject.toml', patterns: ['libs/*'] }]);
    expect(facts.packages.map((p) => [p.path, p.name, p.workspace_member])).toEqual([
      ['.', 'root', false],
      ['libs/core', 'core', true],
      ['services/api', 'api', false],
    ]);
    expect(facts.packages[1]!.dependencies[0]!.resolved).toBe('4.2.30');
    expect(facts.packages[2]!.dependencies[0]!.resolved).toBe('4.2.30');
  });
});

describe('Django settings detection', () => {
  it('reads DJANGO_SETTINGS_MODULE in its usual forms', () => {
    expect(djangoSettingsModule('os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")')).toBe('mysite.settings');
    expect(djangoSettingsModule("os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')")).toBe(
      'config.settings.production',
    );
    expect(djangoSettingsModule('os.environ["DJANGO_SETTINGS_MODULE"] = "proj.settings"')).toBe('proj.settings');
    expect(djangoSettingsModule('print("hello")')).toBeNull();
  });

  it('finds manage.py, the settings module file and wsgi/asgi, with a manage.py in a subfolder', () => {
    const root = tmpDir();
    writeTree(root, {
      'requirements/base.txt': 'Django==4.2.30\n',
      'requirements/dev.txt': '-r base.txt\npytest==8.0.0\n',
      'src/manage.py': 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.base")\n',
      'src/config/__init__.py': '',
      'src/config/settings/__init__.py': '',
      'src/config/settings/base.py': 'DEBUG = False\n',
      'src/config/wsgi.py': 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.base")\n',
      'setup.cfg': '[metadata]\nname = x\n',
      'src/polls/management/commands/__init__.py': '',
      'src/polls/management/commands/setup.py': 'class Command: pass\n',
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.packages).toHaveLength(1);
    const p = facts.packages[0]!;
    expect(p.path).toBe('.');
    expect(p.manifests).toEqual(['requirements/base.txt', 'requirements/dev.txt']);
    expect(p.dependencies.map((d) => [d.name, d.kind, d.resolved])).toEqual([
      ['Django', 'prod', '4.2.30'],
      ['pytest', 'dev', '8.0.0'],
    ]);
    expect(p.entrypoints.map((e) => [e.kind, e.path, e.value, e.confidence])).toEqual([
      ['django_manage', 'src/manage.py', null, 'exact'],
      ['django_settings', 'src/config/settings/base.py', 'config.settings.base', 'heuristic'],
      ['wsgi', 'src/config/wsgi.py', null, 'heuristic'],
    ]);
    expect(p.tests.runners.map((r) => r.name)).toEqual(['pytest', 'django']);
    expect(facts.unrecognised).toEqual(['setup.cfg']);
  });
});

describe('manifest errors are reported, not dropped', () => {
  it('lists an unparseable package.json, tsconfig and lockfile', () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': '{ not json',
      'apps/a/package.json': pkg({ name: 'a', dependencies: { next: '^14.0.0' } }),
      'apps/a/tsconfig.json': '{ "extends": "./base.json", ',
      'apps/a/package-lock.json': '{',
    });
    const facts = analyzeRepo(root, 'r', DEFAULT_LIMITS);
    expect(facts.manifestErrors.map((e) => e.path)).toEqual(['apps/a/package-lock.json', 'apps/a/tsconfig.json', 'package.json']);
    expect(facts.packages.map((p) => p.path)).toEqual(['apps/a']);
  });

  it('records tsconfig extends it cannot follow', () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': pkg({ name: 'a' }),
      'tsconfig.json': JSON.stringify({ extends: ['@tsconfig/node22/tsconfig.json', '../outside.json', './missing'] }),
    });
    const ts = analyzeRepo(root, 'r', DEFAULT_LIMITS).packages[0]!.tsconfig!;
    expect(ts.chain).toEqual(['tsconfig.json']);
    expect(ts.unresolved_extends).toEqual(['@tsconfig/node22/tsconfig.json', '../outside.json', './missing']);
  });
});

describe('size limits', () => {
  const files = { 'a.txt': 'x'.repeat(10), 'b.txt': 'x'.repeat(10), 'c.txt': 'x'.repeat(50), 'd.txt': 'x'.repeat(10) };

  it('skips nothing when everything fits (the zero case)', () => {
    const root = tmpDir();
    writeTree(root, files);
    const walk = walkRepo(root, 'r', DEFAULT_LIMITS);
    expect(walk.skipped).toEqual([]);
    expect(walk.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    expect(walk.bytes).toBe(80);
  });

  it('lists each file skipped by max_file_bytes, max_total_bytes and max_files', () => {
    const root = tmpDir();
    writeTree(root, files);
    expect(walkRepo(root, 'r', { max_files: 100, max_file_bytes: 20, max_total_bytes: 1000 }).skipped).toEqual([
      { path: 'c.txt', reason: 'too_large' },
    ]);
    expect(walkRepo(root, 'r', { max_files: 100, max_file_bytes: 100, max_total_bytes: 25 }).skipped).toEqual([
      { path: 'c.txt', reason: 'max_total_bytes' },
      { path: 'd.txt', reason: 'max_total_bytes' },
    ]);
    const capped = walkRepo(root, 'r', { max_files: 2, max_file_bytes: 100, max_total_bytes: 1000 });
    expect(capped.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(capped.skipped).toEqual([
      { path: 'c.txt', reason: 'max_files' },
      { path: 'd.txt', reason: 'max_files' },
    ]);
  });

  it('lists denied folders once instead of walking them', () => {
    const root = tmpDir();
    writeTree(root, {
      'package.json': '{}',
      'node_modules/next/package.json': '{}',
      'node_modules/next/dist/x.js': '',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.venv/bin/python': '',
    });
    expect(walkRepo(root, 'r', DEFAULT_LIMITS).skipped).toEqual([
      { path: '.git/', reason: 'denied' },
      { path: '.venv/', reason: 'denied' },
      { path: 'node_modules/', reason: 'denied' },
    ]);
  });
});
