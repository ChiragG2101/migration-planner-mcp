// The Python language adapter: tree-sitter compiled to WASM, with the Python
// grammar vendored under ./grammar (version and checksum in its README), so
// there is no native build and no Python subprocess (C3, D2). Source text is
// read through safeRead; imports resolve only to walked files, against the
// package roots (the package folder, its src/, and setuptools or poetry
// package folders from pyproject.toml).
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import type { SafePath } from '../../security/pathBoundary.js';
import { readText } from '../../security/safeRead.js';
import type { FileFacts, ImportDecl, LanguageAdapter, ResolveContext, ResolvedImport, Resolver, SyntaxTree } from '../adapter.js';
import { collectPyImports } from './imports.js';
import { collectPyRefs, collectPySymbols } from './symbols.js';

// <package>/src/lang/python/grammar/, from both src/lang/python/ and dist/lang/python/.
export const GRAMMAR_PATH = fileURLToPath(new URL('../../../src/lang/python/grammar/tree-sitter-python.wasm', import.meta.url));

export interface PyTree extends SyntaxTree {
  readonly lang: 'python';
  readonly tree: Tree;
}

let parser: Parser | null = null;

export async function initPython(): Promise<void> {
  if (parser) return;
  await Parser.init();
  const lang = await Language.load(GRAMMAR_PATH);
  const p = new Parser();
  p.setLanguage(lang);
  parser = p;
}

function parsePy(sp: SafePath): PyTree {
  if (!parser) throw new Error('the Python adapter is not initialised (call init first)');
  const text = readText(sp);
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${sp.requested}`);
  return { lang: 'python', file: sp.requested, text, tree };
}

function factsOf(t: PyTree): FileFacts {
  const root = t.tree.rootNode;
  const { imports, unresolved } = collectPyImports(root);
  const symbols = collectPySymbols(root);
  // Every module-level name can be imported from the module, so each is an export.
  const exports = [
    ...symbols.map((s) => ({ exported: s.name, local: s.name, line: s.line })),
    ...imports.flatMap((d) => d.bindings.filter((b) => b.local !== '*').map((b) => ({ exported: b.local, local: b.local, line: d.line }))),
  ];
  const parse_errors = [];
  if (root.hasError) {
    const bad = root.descendantsOfType('ERROR')[0] ?? null;
    const missing = bad ? null : findMissing(root);
    const at = bad ?? missing;
    parse_errors.push({ line: at ? at.startPosition.row + 1 : null, message: missing ? `syntax error: missing ${missing.type}` : 'syntax error' });
  }
  return { imports, exports, symbols, refs: collectPyRefs(root, imports, symbols), unresolved, parse_errors };
}

function findMissing(n: Tree['rootNode']): Tree['rootNode'] | null {
  if (n.isMissing) return n;
  for (const c of n.children) {
    const m = c && findMissing(c);
    if (m) return m;
  }
  return null;
}

// ---- resolution -------------------------------------------------------------

const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);

/** Package folders a pyproject.toml declares: setuptools `package-dir` and `packages.find.where`, poetry `packages[].from`. */
function declaredRoots(text: string): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tool = (doc.tool ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const out: string[] = [];
  const st = tool.setuptools ?? {};
  const pd = st['package-dir'] as Record<string, string> | undefined;
  if (pd && typeof pd[''] === 'string') out.push(pd['']);
  const where = ((st.packages as Record<string, unknown> | undefined)?.find as Record<string, unknown> | undefined)?.where;
  if (Array.isArray(where)) out.push(...where.filter((w): w is string => typeof w === 'string'));
  const poetry = (tool.poetry?.packages ?? []) as { from?: unknown }[];
  if (Array.isArray(poetry)) for (const p of poetry) if (typeof p.from === 'string') out.push(p.from);
  return out.map((r) => r.replace(/^\.\//, '').replace(/\/+$/, '')).filter((r) => r !== '' && !r.split('/').includes('..'));
}

export function pyResolver(ctx: ResolveContext): Resolver {
  const roots = new Set<string>(['']);
  for (const p of ctx.packages.filter((x) => x.ecosystem === 'python')) {
    roots.add(p.dir);
    roots.add(under(p.dir, 'src'));
    const pyproject = under(p.dir, 'pyproject.toml');
    if (ctx.files.has(pyproject)) for (const r of declaredRoots(ctx.readText(pyproject))) roots.add(under(p.dir, r));
  }
  const rootList = [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const moduleIn = (base: string, dotted: string): string | null => {
    const rel = dotted.split('.').join('/');
    for (const cand of [under(base, `${rel}.py`), under(base, `${rel}/__init__.py`), under(base, `${rel}.pyi`)]) if (ctx.files.has(cand)) return cand;
    return null;
  };
  const absolute = (dotted: string): string | null => {
    for (const r of rootList) {
      const f = moduleIn(r, dotted);
      if (f) return f;
    }
    return null;
  };
  /** `..a.b` from `pkg/sub/mod.py`: up one package per extra dot. */
  const relative = (fromFile: string, spec: string): string | null => {
    const dots = /^\.+/.exec(spec)![0].length;
    let base = dirOf(fromFile);
    for (let i = 1; i < dots; i++) {
      if (base === '') return null;
      base = dirOf(base);
    }
    const rest = spec.slice(dots);
    if (!rest) return ctx.files.has(under(base, '__init__.py')) ? under(base, '__init__.py') : null;
    return moduleIn(base, rest);
  };
  const resolveSpec = (fromFile: string, spec: string): string | null => (spec.startsWith('.') ? relative(fromFile, spec) : absolute(spec));

  return (fromFile: string, decl: ImportDecl): ResolvedImport[] => {
    if (decl.kind === 'string_ref') {
      // `app.middleware.Auth` names a class in app/middleware.py: the module itself, or one trailing name stripped.
      const parts = decl.spec.split('.');
      for (let n = parts.length; n >= Math.max(1, parts.length - 1); n--) {
        const f = absolute(parts.slice(0, n).join('.'));
        if (f) return [{ to_module: decl.spec, to_file: f, binding: null }];
      }
      return [{ to_module: decl.spec, to_file: null, binding: null }];
    }
    const out: ResolvedImport[] = [{ to_module: decl.spec, to_file: resolveSpec(fromFile, decl.spec), binding: null }];
    // `from pkg import views` binds a submodule when pkg/views.py exists.
    for (const b of decl.bindings) {
      if (b.imported === '*') continue;
      const sub = decl.spec.endsWith('.') ? `${decl.spec}${b.imported}` : `${decl.spec}.${b.imported}`;
      const file = resolveSpec(fromFile, sub);
      if (file) out.push({ to_module: sub, to_file: file, binding: b.local });
    }
    return out;
  };
}

export const pythonAdapter: LanguageAdapter = {
  id: 'python',
  version: 1,
  lang: 'python',
  extensions: ['.py', '.pyi'],
  init: initPython,
  scriptKind: () => 'py',
  parse: parsePy,
  imports: (tree) => collectPyImports((tree as PyTree).tree.rootNode).imports,
  symbols: (tree) => collectPySymbols((tree as PyTree).tree.rootNode),
  facts: (tree) => factsOf(tree as PyTree),
  dispose: (tree) => (tree as PyTree).tree.delete(),
  resolver: pyResolver,
};
