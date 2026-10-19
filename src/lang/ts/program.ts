// The TS/JS language adapter. Each file is parsed in its own TypeScript
// Program (noResolve, noLib), so the checker gives real scoping inside the
// file and the facts depend only on the file's content, which lets them be
// cached by sha256. The CompilerHost serves only the one file, read through
// safeRead; the module-resolution host sees only walked files, so neither
// can read outside the root, a deny-listed file or anything over the scan's
// size limits. Imports are resolved with the package's tsconfig options
// (paths, baseUrl, moduleResolution), to targets inside the root only.
import path from 'node:path';
import ts from 'typescript';
import type { SafePath } from '../../security/pathBoundary.js';
import { readText } from '../../security/safeRead.js';
import { extensionOf, type FileFacts, type ImportDecl, type LanguageAdapter, type ResolveContext, type Resolver, type SyntaxTree } from '../adapter.js';
import { collectImports } from './imports.js';
import { collectRefs, collectSymbols } from './symbols.js';

export interface TsTree extends SyntaxTree {
  readonly lang: 'ts';
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly syntaxErrors: readonly ts.Diagnostic[];
}

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

function scriptKindOf(file: string): ts.ScriptKind {
  switch (extensionOf(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TS;
  }
}

// Options for parsing one file: no lib files, no module resolution, so the
// program never asks the host for any other file.
const parseOptions: ts.CompilerOptions = {
  noResolve: true,
  noLib: true,
  types: [],
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
};

/** A CompilerHost that knows exactly one source file and nothing else. */
function singleFileHost(fileName: string, sourceFile: ts.SourceFile): ts.CompilerHost {
  return {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => '/__no_lib__.d.ts',
    writeFile: () => {
      throw new Error('the TS adapter never writes');
    },
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? sourceFile.text : undefined),
    directoryExists: () => false,
    getDirectories: () => [],
  };
}

export function parseTs(sp: SafePath): TsTree {
  const text = readText(sp);
  // A virtual absolute name: the program never maps it back to the disk.
  const fileName = `/${sp.requested}`;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(sp.requested));
  const program = ts.createProgram({ rootNames: [fileName], options: parseOptions, host: singleFileHost(fileName, sourceFile) });
  return {
    lang: 'ts',
    file: sp.requested,
    text,
    sourceFile,
    checker: program.getTypeChecker(),
    syntaxErrors: program.getSyntacticDiagnostics(sourceFile),
  };
}

function factsOf(tree: TsTree): FileFacts {
  const { imports, exports, unresolved } = collectImports(tree.sourceFile);
  const symbols = collectSymbols(tree.sourceFile);
  const parse_errors = tree.syntaxErrors.map((d) => ({
    line: d.start === undefined ? null : tree.sourceFile.getLineAndCharacterOfPosition(d.start).line + 1,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));
  return { imports, exports, symbols, refs: collectRefs(tree.sourceFile, tree.checker, imports, symbols), unresolved, parse_errors };
}

// ---- module resolution over walked files only -------------------------------

const defaultResolveOptions: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  allowJs: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.Preserve,
};

interface WalkedHost {
  host: ts.ModuleResolutionHost & ts.ParseConfigHost;
  toRel(abs: string): string | null;
}

function walkedHost(ctx: ResolveContext): WalkedHost {
  const dirs = new Set<string>(['']);
  for (const f of ctx.files) for (let d = f; d.includes('/'); ) dirs.add((d = d.slice(0, d.lastIndexOf('/'))));
  const toRel = (abs: string): string | null => {
    const rel = path.relative(ctx.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  };
  const isFile = (abs: string): boolean => {
    const rel = toRel(abs);
    return rel !== null && ctx.files.has(rel);
  };
  const host: ts.ModuleResolutionHost & ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: isFile,
    readFile: (abs) => {
      const rel = toRel(abs);
      return rel !== null && ctx.files.has(rel) ? ctx.readText(rel) : undefined;
    },
    directoryExists: (abs) => {
      const rel = toRel(abs);
      return rel !== null && dirs.has(rel);
    },
    realpath: (abs) => abs,
    getCurrentDirectory: () => ctx.root,
    getDirectories: () => [],
    readDirectory: () => [],
  };
  return { host, toRel };
}

/** Compiler options for a package: its tsconfig (read through the walked host), else the inferred defaults. */
function packageOptions(ctx: ResolveContext, wh: WalkedHost, tsconfig: string | null): ts.CompilerOptions {
  if (!tsconfig || !ctx.files.has(tsconfig)) return defaultResolveOptions;
  const abs = path.join(ctx.root, tsconfig);
  const parsed = ts.parseConfigFileTextToJson(abs, ctx.readText(tsconfig));
  if (parsed.error) return defaultResolveOptions;
  const content = ts.parseJsonConfigFileContent(parsed.config, wh.host, path.dirname(abs), undefined, abs);
  const options = { ...content.options, allowJs: true, resolveJsonModule: true, noEmit: true };
  if (options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  if (options.moduleResolution === ts.ModuleResolutionKind.Bundler && options.module === undefined) options.module = ts.ModuleKind.ESNext;
  return options;
}

export function tsResolver(ctx: ResolveContext): Resolver {
  const wh = walkedHost(ctx);
  const nodePkgs = ctx.packages.filter((p) => p.ecosystem === 'node').sort((a, b) => b.dir.length - a.dir.length);
  const optionsByDir = new Map<string, ts.CompilerOptions>();
  const optionsFor = (file: string): ts.CompilerOptions => {
    const pkg = nodePkgs.find((p) => p.dir === '' || file.startsWith(`${p.dir}/`));
    const key = pkg?.dir ?? '';
    let opts = optionsByDir.get(key);
    if (!opts) optionsByDir.set(key, (opts = packageOptions(ctx, wh, pkg?.tsconfig ?? null)));
    return opts;
  };
  const named = nodePkgs.filter((p): p is typeof p & { name: string } => p.name !== null);
  const resolveFrom = (spec: string, fromAbs: string, opts: ts.CompilerOptions): string | null => {
    const res = ts.resolveModuleName(spec, fromAbs, opts, wh.host).resolvedModule;
    if (!res || res.isExternalLibraryImport) return null;
    const rel = wh.toRel(res.resolvedFileName);
    return rel !== null && ctx.files.has(rel) ? rel : null;
  };
  const resolve = (fromFile: string, decl: ImportDecl): string | null => {
    const fromAbs = path.join(ctx.root, fromFile);
    const opts = optionsFor(fromFile);
    const direct = resolveFrom(decl.spec, fromAbs, opts);
    if (direct || decl.spec.startsWith('.')) return direct;
    // A workspace package imported by name: its node_modules link is deny-listed, so resolve it by folder.
    const pkg = named.find((p) => decl.spec === p.name || decl.spec.startsWith(`${p.name}/`));
    if (!pkg) return null;
    const target = path.posix.join(pkg.dir, decl.spec.slice(pkg.name.length));
    const relSpec = path.posix.relative(path.posix.dirname(fromFile), target) || '.';
    return resolveFrom(relSpec.startsWith('.') ? relSpec : `./${relSpec}`, fromAbs, opts);
  };
  return (fromFile, decl) => [{ to_module: decl.spec, to_file: resolve(fromFile, decl), binding: null }];
}

export const tsAdapter: LanguageAdapter = {
  id: 'ts',
  version: 1,
  lang: 'ts',
  extensions,
  scriptKind: (file) => String(scriptKindOf(file)),
  parse: parseTs,
  imports: (tree) => collectImports((tree as TsTree).sourceFile).imports,
  symbols: (tree) => collectSymbols((tree as TsTree).sourceFile),
  facts: (tree) => factsOf(tree as TsTree),
  resolver: tsResolver,
};
