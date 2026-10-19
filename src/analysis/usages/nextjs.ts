// The Next.js usage adapter (pack 1). It finds the code an upgrade from
// Next.js 14 through 16 and React 18 to 19 can touch, checked against the
// official upgrade guides (nextjs.org version-15 and version-16, react.dev
// React 19 upgrade guide; M2 task 8): request APIs and their wrappers, route
// props, caching and segment config, config keys, renamed and removed
// imports, the React removals, peer ranges and dependencies. It decides what
// a usage is, never what it means: rules (M3) and lenses (M5) do that.
import semver from 'semver';
import ts from 'typescript';
import type { Ref } from '../../lang/adapter.js';
import type { Origin } from '../../lang/graph.js';
import type { TsTree } from '../../lang/ts/program.js';
import { bindingNames, isDefaultExport, isExported, lineOf, literalText } from '../../lang/ts/imports.js';
import type { MatchKind } from '../../schema/usage.js';
import { parsePackageJson, parsePeerRanges } from '../manifests/node.js';
import type { PackageFacts } from '../scanner.js';
import type { DetectResult, UsageAdapter, UsageContext, UsageDraft } from './adapter.js';
import { traceUses } from './trace.js';

// ---- what the adapter looks for --------------------------------------------

interface ApiTarget {
  module: string;
  names: readonly string[];
  kind: string;
  match: MatchKind;
  /** Callers of a wrapper must change too (an async API makes its wrapper async). */
  follow: boolean;
}

/** Named exports whose uses are usages, wherever they are referenced from. */
const apiTargets: readonly ApiTarget[] = [
  { module: 'next/headers', names: ['cookies', 'headers', 'draftMode'], kind: 'request_api', match: 'call', follow: true },
  { module: 'next/cache', names: ['revalidateTag'], kind: 'cache_api', match: 'call', follow: false },
  { module: 'next/cache', names: ['unstable_cacheLife', 'unstable_cacheTag'], kind: 'renamed_api', match: 'import', follow: false },
  { module: 'next/server', names: ['unstable_rootParams'], kind: 'removed_api', match: 'import', follow: false },
  {
    module: 'react-dom',
    names: ['render', 'hydrate', 'unmountComponentAtNode', 'findDOMNode', 'unstable_renderSubtreeIntoContainer'],
    kind: 'react_removed_api',
    match: 'call',
    follow: false,
  },
  { module: 'react-dom', names: ['useFormState'], kind: 'react_renamed_api', match: 'call', follow: false },
  { module: 'react', names: ['createFactory'], kind: 'react_removed_api', match: 'call', follow: false },
  { module: 'react', names: ['MutableRefObject'], kind: 'react_types', match: 'import', follow: false },
];

interface ImportTarget {
  test: (spec: string) => boolean;
  kind: string;
}

/** Modules whose import is itself the usage (the line to change is the import). */
const importTargets: readonly ImportTarget[] = [
  { test: (s) => s === '@next/font' || s.startsWith('@next/font/'), kind: 'removed_package' },
  { test: (s) => s === 'next/legacy/image', kind: 'deprecated_import' },
  { test: (s) => s === 'next/amp', kind: 'removed_api' },
  { test: (s) => s === 'next/config', kind: 'runtime_config' },
  { test: (s) => s.startsWith('next/dist/'), kind: 'internal_import' },
  { test: (s) => s === 'react-dom/test-utils', kind: 'react_removed_import' },
  { test: (s) => s === 'react-test-renderer' || s.startsWith('react-test-renderer/'), kind: 'react_removed_import' },
];

const segmentConfigNames = new Set([
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'experimental_ppr',
]);
const routeMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Declared dependencies worth listing as facts: the libraries the upgrade moves and the ones it removes. */
const watchedDeps = new Set([
  'next',
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  '@next/font',
  'eslint-config-next',
  '@next/eslint-plugin-next',
  'react-test-renderer',
  'typescript',
]);
/** Peer ranges on these libraries are recorded; a conflict is labelled once the target version is known. */
const peerLibraries = ['next', 'react', 'react-dom'];

/** next.config keys looked for by text when the config object can't be read statically. */
const configFallbackKeys = [
  'experimental',
  'serverComponentsExternalPackages',
  'bundlePagesExternals',
  'turbopack',
  'ppr',
  'dynamicIO',
  'useCache',
  'images',
  'domains',
  'eslint',
  'amp',
  'serverRuntimeConfig',
  'publicRuntimeConfig',
  'devIndicators',
  'skipMiddlewareUrlNormalize',
  'webpack',
  'staleTimes',
];

const conventionRe = /^(page|layout|route|default|template|not-found|error|loading|opengraph-image|twitter-image|icon|apple-icon|sitemap)\.(jsx?|tsx?|mjs)$/;
const configFileRe = /^next\.config\.(js|mjs|cjs|ts|mts)$/;
const middlewareFileRe = /^middleware\.(js|mjs|ts|mts)$/;
const sassRe = /\.(scss|sass)$/;

// ---- per-file syntax facts (cached by content) ------------------------------

interface ParamUse {
  fn: string;
  index: number;
  prop: string;
  line: number;
  end_line: number;
}

interface NextLocal {
  use_client: boolean;
  param_uses: ParamUse[];
  /** JSX attributes that pass a request prop (or the whole props object's prop) to a component. */
  prop_passes: { line: number; tag: string; prop: string }[];
  segment_exports: { name: string; line: number }[];
  route_methods: { name: string; line: number }[];
  fetch_calls: { line: number; end_line: number; awaited: boolean; cache_option: boolean }[];
  string_refs: number[];
  fn_statics: { component: string; prop: string; line: number }[];
  legacy_context: { name: string; line: number }[];
  jsx_global: number[];
  use_ref_no_arg: { line: number; callee: string }[];
  config_keys: { path: string; line: number }[] | null;
  /** The exported config is not fully static (no object found, or a spread): the text fallback runs too. */
  config_dynamic: boolean;
  middleware: { line: number; geo_ip: { prop: string; line: number }[] } | null;
}

const requestProps = new Set(['params', 'searchParams', 'id']);

/** Request props a function reads from its parameter at `index`: destructured, or read as `props.params`. */
function paramUses(sf: ts.SourceFile, fn: ts.SignatureDeclaration, name: string, out: ParamUse[]): void {
  fn.parameters.forEach((param, index) => {
    if (index > 1) return;
    if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
        if (prop && requestProps.has(prop)) out.push({ fn: name, index, prop, line: lineOf(sf, el), end_line: lineOf(sf, el) });
      }
    } else if (ts.isIdentifier(param.name) && 'body' in fn && fn.body) {
      const propsName = param.name.text;
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === propsName && requestProps.has(n.name.text)) {
          out.push({ fn: name, index, prop: n.name.text, line: lineOf(sf, n), end_line: lineOf(sf, n) });
        }
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
    }
  });
}

const functionOf = (init: ts.Expression | undefined): ts.SignatureDeclaration | null => {
  let e = init;
  // `export default withAuth(async function Page() {})` keeps the inner function.
  while (e && ts.isCallExpression(e) && e.arguments.length) e = e.arguments[0];
  return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : null;
};

/**
 * The object literals a config file exports, following `const c = {...}`,
 * wrappers such as `withX(c)` and `Object.assign({}, a, {...})`, and
 * `(phase) => ({...})`. Null when the export is not a config-like expression.
 */
function configObjects(sf: ts.SourceFile): ts.ObjectLiteralExpression[] | null {
  const vars = new Map<string, ts.Expression>();
  let exported: ts.Expression | null = null;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) vars.set(d.name.text, d.initializer);
    } else if (ts.isExportAssignment(stmt)) exported = stmt.expression;
    else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
      const left = stmt.expression.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports') {
        exported = stmt.expression.right;
      }
    }
  }
  const resolve = (e: ts.Expression | undefined, depth: number): ts.ObjectLiteralExpression[] => {
    if (!e || depth > 6) return [];
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isIdentifier(e)) return resolve(vars.get(e.text), depth + 1);
    if (ts.isCallExpression(e)) return e.arguments.flatMap((a) => resolve(a, depth + 1));
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (!ts.isBlock(e.body)) return resolve(e.body, depth + 1);
      const found: ts.ObjectLiteralExpression[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isReturnStatement(n)) found.push(...resolve(n.expression, depth + 1));
        else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
      };
      visit(e.body);
      return found;
    }
    return [];
  };
  const objects = resolve(exported ?? undefined, 0);
  return objects.length ? objects : null;
}

function configKeys(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, prefix = '', depth = 0): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  for (const p of obj.properties) {
    const nameNode = 'name' in p ? p.name : undefined;
    const key = nameNode && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) ? nameNode.text : null;
    if (!key) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.push({ path, line: lineOf(sf, p) });
    if (depth < 3 && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) out.push(...configKeys(sf, p.initializer, path, depth + 1));
  }
  return out;
}

function scanNextFile(tree: TsTree): NextLocal {
  const sf = tree.sourceFile;
  const checker = tree.checker;
  // A global (fetch, JSX) has no declaration in the file; the checker may still return a placeholder symbol.
  const unbound = (id: ts.Identifier): boolean => !(checker.getSymbolAtLocation(id)?.declarations?.length);
  const first = sf.statements[0];
  const local: NextLocal = {
    use_client: !!first && ts.isExpressionStatement(first) && literalText(first.expression) === 'use client',
    param_uses: [],
    prop_passes: [],
    segment_exports: [],
    route_methods: [],
    fetch_calls: [],
    string_refs: [],
    fn_statics: [],
    legacy_context: [],
    jsx_global: [],
    use_ref_no_arg: [],
    config_keys: null,
    config_dynamic: false,
    middleware: null,
  };
  const topFns = new Map<string, ts.SignatureDeclaration>();
  const topClasses = new Set<string>();
  let defaultName: string | null = null;

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? 'default';
      topFns.set(name, stmt);
      if (isExported(stmt) && isDefaultExport(stmt)) defaultName = name;
      if (isExported(stmt) && routeMethods.has(name)) local.route_methods.push({ name, line: lineOf(sf, stmt) });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) topClasses.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const fn = functionOf(d.initializer);
        for (const n of bindingNames(d.name)) {
          if (fn) topFns.set(n, fn);
          if (isExported(stmt) && segmentConfigNames.has(n)) local.segment_exports.push({ name: n, line: lineOf(sf, d) });
          if (isExported(stmt) && n === 'config') local.segment_exports.push({ name: n, line: lineOf(sf, d) });
          if (isExported(stmt) && routeMethods.has(n)) local.route_methods.push({ name: n, line: lineOf(sf, d) });
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (ts.isIdentifier(stmt.expression)) defaultName = stmt.expression.text;
      else {
        const fn = functionOf(stmt.expression);
        if (fn) {
          topFns.set('default', fn);
          defaultName = 'default';
        }
      }
    } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // `Button.defaultProps = {...}` on a function component; `X.contextTypes = {...}` on any component.
      const left = stmt.expression.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)) {
        const prop = left.name.text;
        const owner = left.expression.text;
        if ((prop === 'defaultProps' || prop === 'propTypes') && topFns.has(owner)) local.fn_statics.push({ component: owner, prop, line: lineOf(sf, stmt) });
        if ((prop === 'contextTypes' || prop === 'childContextTypes') && (topFns.has(owner) || topClasses.has(owner))) {
          local.legacy_context.push({ name: prop, line: lineOf(sf, stmt) });
        }
      }
    }
  }

  // Request props read by the default export, the metadata functions and route handlers.
  const fnNames = new Set(['generateMetadata', 'generateViewport', ...routeMethods]);
  if (defaultName && topFns.has(defaultName)) paramUses(sf, topFns.get(defaultName)!, 'default', local.param_uses);
  for (const [name, fn] of topFns) if (fnNames.has(name)) paramUses(sf, fn, name, local.param_uses);
  const propLocals = new Set(local.param_uses.map((p) => p.prop));

  const middlewareFn = topFns.get('middleware') ?? (defaultName ? topFns.get(defaultName) : undefined);
  if (middlewareFn && middlewareFn.parameters[0] && ts.isIdentifier(middlewareFn.parameters[0].name)) {
    const req = middlewareFn.parameters[0].name.text;
    const geo_ip: { prop: string; line: number }[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === req && (n.name.text === 'geo' || n.name.text === 'ip')) {
        geo_ip.push({ prop: n.name.text, line: lineOf(sf, n) });
      }
      ts.forEachChild(n, visit);
    };
    if ('body' in middlewareFn && middlewareFn.body) visit(middlewareFn.body);
    local.middleware = { line: lineOf(sf, middlewareFn), geo_ip };
  }

  const objects = configObjects(sf);
  if (objects) local.config_keys = objects.flatMap((o) => configKeys(sf, o));
  local.config_dynamic = !objects || objects.some((o) => o.properties.some(ts.isSpreadAssignment));

  const isTsFile = /\.(ts|tsx|mts|cts)$/.test(tree.file);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch' && unbound(callee)) {
        const opts = n.arguments[1];
        const cache_option =
          !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name && ts.isIdentifier(p.name) && (p.name.text === 'cache' || p.name.text === 'next'));
        let parent = n.parent;
        while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
        local.fetch_calls.push({ line: lineOf(sf, n), end_line: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1, awaited: ts.isAwaitExpression(parent), cache_option });
      }
      const calleeText = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : null;
      if (isTsFile && n.arguments.length === 0 && (calleeText === 'useRef' || calleeText === 'React.useRef')) {
        local.use_ref_no_arg.push({ line: lineOf(sf, n), callee: calleeText });
      }
    } else if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name)) {
      const init = n.initializer;
      const value = init && ts.isJsxExpression(init) ? init.expression : init;
      if (n.name.text === 'ref' && value && ts.isStringLiteral(value)) local.string_refs.push(lineOf(sf, n));
      // `<Client params={params} />` or `params={props.params}`: a request prop handed to another component.
      let prop: string | null = null;
      if (value && ts.isIdentifier(value) && propLocals.has(value.text)) prop = value.text;
      if (value && ts.isPropertyAccessExpression(value) && requestProps.has(value.name.text) && ts.isIdentifier(value.expression)) prop = value.name.text;
      if (prop) {
        const opening = n.parent.parent;
        if (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) {
          local.prop_passes.push({ line: lineOf(sf, n), tag: opening.tagName.getText(sf), prop });
        }
      }
    } else if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === 'refs') {
      local.string_refs.push(lineOf(sf, n));
    } else if ((ts.isPropertyDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && ts.isClassLike(n.parent)) {
      if (['contextTypes', 'childContextTypes', 'getChildContext'].includes(n.name.text)) local.legacy_context.push({ name: n.name.text, line: lineOf(sf, n) });
    } else if (ts.isTypeReferenceNode(n) && ts.isQualifiedName(n.typeName) && ts.isIdentifier(n.typeName.left) && n.typeName.left.text === 'JSX') {
      // The global JSX namespace (React 19 types move it to React.JSX); a local or imported JSX is not it.
      if (unbound(n.typeName.left)) local.jsx_global.push(lineOf(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  local.string_refs = [...new Set(local.string_refs)];
  local.jsx_global = [...new Set(local.jsx_global)];
  return local;
}

// ---- detection over the whole repo -------------------------------------------

const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);
const inDir = (dir: string, file: string): boolean => dir === '' || file.startsWith(`${dir}/`);

function nextPackageDirs(packages: readonly PackageFacts[]): string[] {
  return packages
    .filter((p) => p.ecosystem === 'node' && (p.dependencies.some((d) => d.name === 'next') || p.entrypoints.some((e) => e.kind === 'next_config')))
    .map((p) => (p.path === '.' ? '' : p.path));
}

/** The 1-based line of the first line containing `needle`, or 1. */
function lineOfText(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

function detect(ctx: UsageContext): DetectResult {
  const out: UsageDraft[] = [];
  const peerUnavailable: string[] = [];
  const add = (d: Omit<UsageDraft, 'via' | 'labels' | 'confidence' | 'module'> & Partial<UsageDraft>): void => {
    out.push({ via: [], labels: [], confidence: 'exact', module: null, ...d });
  };
  const local = (file: string): NextLocal | null => ctx.local(file) as NextLocal | null;
  const nextDirs = nextPackageDirs(ctx.packages);
  const nextDirOf = (file: string): string | null => nextDirs.filter((d) => inDir(d, file)).sort((a, b) => b.length - a.length)[0] ?? null;

  // 1. Named APIs, directly, through barrels and (for request APIs) through wrappers.
  const hits = traceUses(ctx, {
    match: (o: Origin) => {
      const t = o.kind === 'external' ? apiTargets.find((x) => x.module === o.module && x.names.includes(o.name)) : undefined;
      return t && o.kind === 'external' ? { ...t, name: o.name } : null;
    },
    followWrappers: (t) => t.follow,
  });
  for (const h of hits) {
    const labels: string[] = [];
    if (h.via.length) labels.push('indirect');
    if (h.ref.ctx === 'type' || isTypeOnlyBinding(ctx, h.file, h.ref)) labels.push('type_only');
    if (h.ref.awaited) labels.push('awaited');
    add({
      file: h.file,
      line_start: h.ref.line,
      line_end: h.ref.end_line,
      kind: h.target.kind,
      symbol: `${h.target.module}.${h.target.name}`,
      module: h.target.module,
      match_kind: h.target.match,
      via: h.via,
      labels,
    });
  }

  // 2. Imports that are the usage themselves.
  for (const file of ctx.files) {
    for (const d of ctx.facts(file)?.imports ?? []) {
      const t = importTargets.find((x) => x.test(d.spec));
      if (!t || d.kind === 'string_ref') continue;
      add({ file, line_start: d.line, line_end: d.line, kind: t.kind, symbol: d.spec, module: d.spec, match_kind: 'import', labels: d.type_only ? ['type_only'] : [] });
    }
  }

  // 3. React patterns the React 19 upgrade removes, in any file.
  for (const file of ctx.files) {
    const l = local(file);
    if (!l) continue;
    for (const line of l.string_refs) add({ file, line_start: line, line_end: line, kind: 'react_legacy', symbol: 'string_ref', module: 'react', match_kind: 'file_convention' });
    for (const s of l.fn_statics) add({ file, line_start: s.line, line_end: s.line, kind: 'react_legacy', symbol: s.prop, module: 'react', match_kind: 'file_convention' });
    for (const c of l.legacy_context) add({ file, line_start: c.line, line_end: c.line, kind: 'react_legacy', symbol: 'legacy_context', module: 'react', match_kind: 'file_convention' });
    for (const line of l.jsx_global) add({ file, line_start: line, line_end: line, kind: 'react_types', symbol: 'JSX', module: 'react', match_kind: 'file_convention', labels: ['type_only'] });
    for (const u of l.use_ref_no_arg) {
      const o = ctx.graph.resolveLocal(file, u.callee.split('.')[0]!);
      const fromReact = (o.kind === 'external' || o.kind === 'namespace') && o.module === 'react';
      if (fromReact) add({ file, line_start: u.line, line_end: u.line, kind: 'react_types', symbol: 'react.useRef', module: 'react', match_kind: 'call' });
    }
  }

  // 4. Next.js file conventions, caching, config and middleware, per Next.js package.
  for (const dir of nextDirs) {
    const appRoots = [under(dir, 'app'), under(dir, 'src/app')];
    const pagesRoots = [under(dir, 'pages'), under(dir, 'src/pages')];
    const own = (file: string): boolean => nextDirOf(file) === dir;
    const slots = new Map<string, string[]>();
    for (const file of ctx.files.filter(own)) {
      const l = local(file);
      const base = baseOf(file);
      const appRoot = appRoots.find((r) => file.startsWith(`${r}/`));
      const inPages = pagesRoots.some((r) => file.startsWith(`${r}/`));
      if (appRoot) {
        for (const seg of file.slice(appRoot.length + 1).split('/').slice(0, -1).map((_, i, arr) => arr.slice(0, i + 1).join('/'))) {
          if (baseOf(seg).startsWith('@')) slots.set(`${appRoot}/${seg}`, [...(slots.get(`${appRoot}/${seg}`) ?? []), file]);
        }
      }
      const convention = appRoot ? conventionRe.exec(base)?.[1] : undefined;
      if (l && convention) {
        for (const p of l.param_uses) {
          if (!propAllowed(convention, p)) continue;
          add({ file, line_start: p.line, line_end: p.end_line, kind: 'request_props', symbol: p.prop, module: 'next', match_kind: 'file_convention', labels: p.fn === 'default' ? [] : [p.fn] });
        }
        for (const pass of l.prop_passes) {
          const tagOrigin = ctx.graph.resolveLocal(file, pass.tag.split('.')[0]!);
          const client = tagOrigin.kind === 'local' && (local(tagOrigin.file)?.use_client ?? false);
          add({
            file,
            line_start: pass.line,
            line_end: pass.line,
            kind: 'request_props',
            symbol: pass.prop,
            module: 'next',
            match_kind: 'file_convention',
            labels: client ? ['passed_to_client'] : ['passed_to_component'],
            via: tagOrigin.kind === 'local' ? [{ file: tagOrigin.file, line: 1, symbol: pass.tag }] : [],
          });
        }
        if (convention === 'route') {
          for (const m of l.route_methods.filter((x) => x.name === 'GET')) {
            add({ file, line_start: m.line, line_end: m.line, kind: 'route_handler', symbol: 'GET', module: 'next', match_kind: 'file_convention' });
          }
        }
      }
      if (l && (appRoot || inPages)) {
        for (const s of l.segment_exports) {
          if (s.name === 'config' && !inPages) continue;
          if (s.name !== 'config' && !appRoot) continue;
          add({ file, line_start: s.line, line_end: s.line, kind: 'segment_config', symbol: s.name, module: 'segment', match_kind: 'config_key' });
        }
      }
      // fetch in server code: not a client component, not the pages router.
      if (l && !l.use_client && !inPages) {
        for (const f of l.fetch_calls) {
          const labels = [...(f.awaited ? ['awaited'] : []), ...(f.cache_option ? ['cache_option'] : [])];
          add({ file, line_start: f.line, line_end: f.end_line, kind: 'fetch_call', symbol: 'fetch', match_kind: 'call', labels });
        }
      }
      if (configFileRe.test(base) && dirOf(file) === dir) {
        const exact = l?.config_keys ?? [];
        for (const k of exact) add({ file, line_start: k.line, line_end: k.line, kind: 'config_key', symbol: k.path, module: 'next.config', match_kind: 'config_key' });
        if (!l || l.config_dynamic) {
          // Part of the config can't be read statically: the text scanner covers the lines not already found (heuristic).
          const seen = new Set(exact.map((k) => k.line));
          for (const hit of ctx.scanText(file, configFallbackKeys.map((k) => ({ id: k, literal: k })))) {
            if (seen.has(hit.line)) continue;
            add({ file, line_start: hit.line, line_end: hit.line, kind: 'config_key', symbol: hit.pattern, module: 'next.config', match_kind: 'config_key', confidence: 'heuristic' });
          }
        }
      }
      if (middlewareFileRe.test(base) && (dirOf(file) === dir || dirOf(file) === under(dir, 'src'))) {
        add({ file, line_start: l?.middleware?.line ?? 1, line_end: l?.middleware?.line ?? 1, kind: 'middleware', symbol: 'middleware', module: 'next', match_kind: 'file_convention' });
        for (const g of l?.middleware?.geo_ip ?? []) {
          add({ file, line_start: g.line, line_end: g.line, kind: 'request_geo', symbol: `NextRequest.${g.prop}`, module: 'next/server', match_kind: 'attribute' });
        }
      }
    }
    // Parallel route slots need an explicit default.* (Next.js 16).
    for (const [slot, files] of [...slots].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const direct = files.filter((f) => dirOf(f) === slot);
      if (direct.some((f) => /^default\.(jsx?|tsx?|mjs)$/.test(baseOf(f)))) continue;
      const anchor = (direct.length ? direct : files).sort()[0]!;
      add({ file: anchor, line_start: 1, line_end: 1, kind: 'parallel_route', symbol: slot.slice(slot.lastIndexOf('/') + 1), module: 'next', match_kind: 'file_convention' });
    }

    // package.json: watched dependencies and `next lint` in scripts.
    const manifest = under(dir, 'package.json');
    if (ctx.textFiles.includes(manifest)) {
      const text = ctx.readText(manifest);
      let pkg;
      try {
        pkg = parsePackageJson(text);
      } catch {
        pkg = null;
      }
      for (const d of pkg?.deps ?? []) {
        if (!watchedDeps.has(d.name)) continue;
        const line = lineOfText(text, `"${d.name}"`);
        add({ file: manifest, line_start: line, line_end: line, kind: 'dependency', symbol: d.name, module: d.name, match_kind: 'dependency', labels: [d.kind] });
      }
      for (const hit of ctx.scanText(manifest, [{ id: 'next lint', literal: 'next lint' }])) {
        add({ file: manifest, line_start: hit.line, line_end: hit.line, kind: 'next_lint_script', symbol: 'next lint', module: 'next', match_kind: 'file_convention', confidence: 'heuristic' });
      }
    }
  }

  // 5. Sass imports with the `~` prefix Turbopack does not support (text, heuristic).
  for (const file of ctx.textFiles.filter((f) => sassRe.test(f) && nextDirOf(f) !== null)) {
    const patterns = ['@import \'~', '@import "~', '@use \'~', '@use "~', '@forward \'~', '@forward "~'].map((literal) => ({ id: 'tilde', literal }));
    for (const hit of ctx.scanText(file, patterns)) {
      add({ file, line_start: hit.line, line_end: hit.line, kind: 'sass_tilde_import', symbol: '~', module: null, match_kind: 'file_convention', confidence: 'heuristic' });
    }
  }

  // 6. Peer ranges on next/react/react-dom recorded in the lockfiles.
  for (const lock of ctx.lockfiles) {
    if (lock.kind !== 'npm' && lock.kind !== 'pnpm' && lock.kind !== 'yarn') continue;
    if (!nextDirs.some((d) => inDir(dirOf(lock.path), d) || inDir(d, lock.path))) continue;
    const text = ctx.readText(lock.path);
    let entries;
    try {
      entries = parsePeerRanges(lock.kind, text);
    } catch {
      entries = null;
    }
    if (!entries) {
      peerUnavailable.push(lock.path);
      continue;
    }
    for (const e of entries) {
      for (const lib of peerLibraries) {
        const range = e.peers[lib];
        if (!range) continue;
        const target = ctx.targets[lib];
        const labels: string[] = [];
        if (e.optional.includes(lib)) labels.push('optional_peer');
        if (target && semver.validRange(range) && !semver.satisfies(target, range)) labels.push('peer_conflict');
        const line = lineOfText(text, e.key);
        add({ file: lock.path, line_start: line, line_end: line, kind: 'peer_dependency', symbol: `${e.name}@${e.version} peer ${lib}@${range}`, module: lib, match_kind: 'dependency', labels });
      }
    }
  }
  return { usages: out, peer_data_unavailable: peerUnavailable };
}

/** Which request props each file convention passes to which function (version-15 and version-16 guides). */
function propAllowed(convention: string, p: ParamUse): boolean {
  if (routeMethods.has(p.fn)) return convention === 'route' && p.index === 1 && p.prop === 'params';
  if (p.index !== 0) return false;
  if (p.fn === 'generateMetadata' || p.fn === 'generateViewport') return (convention === 'page' || convention === 'layout') && p.prop !== 'id';
  switch (convention) {
    case 'page':
      return p.prop === 'params' || p.prop === 'searchParams';
    case 'layout':
    case 'default':
      return p.prop === 'params';
    case 'opengraph-image':
    case 'twitter-image':
    case 'icon':
    case 'apple-icon':
      return p.prop === 'params' || p.prop === 'id';
    case 'sitemap':
      return p.prop === 'id';
    default:
      return false;
  }
}

function isTypeOnlyBinding(ctx: UsageContext, file: string, ref: Ref): boolean {
  for (const d of ctx.facts(file)?.imports ?? []) {
    const b = d.bindings.find((x) => x.local === ref.binding);
    if (b) return b.type_only;
  }
  return false;
}

export const nextjsAdapter: UsageAdapter = {
  id: 'nextjs',
  version: 3,
  languages: ['ts'],
  match_kinds: ['import', 'call', 'attribute', 'config_key', 'dependency', 'file_convention'],
  usage_kinds: [
    'request_api',
    'request_props',
    'cache_api',
    'renamed_api',
    'removed_api',
    'runtime_config',
    'removed_package',
    'deprecated_import',
    'internal_import',
    'route_handler',
    'segment_config',
    'fetch_call',
    'middleware',
    'request_geo',
    'config_key',
    'parallel_route',
    'react_removed_api',
    'react_renamed_api',
    'react_removed_import',
    'react_legacy',
    'react_types',
    'sass_tilde_import',
    'next_lint_script',
    'dependency',
    'peer_dependency',
    'unresolved_dynamic',
  ],
  excludes: ['.next', '.vercel', '.turbo'],
  scanFile: (tree) => (tree.lang === 'ts' ? scanNextFile(tree as TsTree) : null),
  detect,
};
