// Node package facts for scan_repo: entrypoints, test setup and the tsconfig
// chain, from manifests already read through the path boundary.
import path from 'node:path';
import type { Entrypoint, TestSetup, TsConfigInfo } from '../../schema/scan.js';
import { type parsePackageJson, parseTsConfig } from '../manifests/node.js';
import { baseOf, byName, dirOf, sortEntrypoints, under } from '../walk.js';

const posix = path.posix;
const jestDefaultGlobs = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];
const vitestDefaultGlobs = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const playwrightDefaultGlobs = ['**/*.@(spec|test).?(c|m)[jt]s?(x)'];
const configExts = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'json'];

/** A package-relative path from a manifest, normalised to the repo; null if it leaves the root. */
function inRepo(dir: string, value: string): string | null {
  const p = posix.normalize(under(dir, value.replace(/^\.\//, '')));
  return p.startsWith('..') || posix.isAbsolute(p) ? null : p.replace(/\/$/, '');
}

export function nodeEntrypoints(
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

export function nodeTests(dir: string, pkg: ReturnType<typeof parsePackageJson>, depNames: Set<string>, exists: (rel: string) => boolean): TestSetup {
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

export function tsChain(
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
