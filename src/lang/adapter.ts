// One interface for every language. An adapter parses a file it is handed as
// a SafePath (read through src/security/safeRead.ts, so the boundary and the
// deny list hold inside every parser) and returns plain, JSON-safe facts:
// imports as written, top-level symbols, and references to top-level
// bindings. Resolving imports to files needs the whole repo, so it is a
// separate step (`resolver`), and the facts can be cached by file content.
import type { SafePath } from '../security/pathBoundary.js';

export type Lang = 'ts' | 'python';

export type ImportKind = 'import' | 'export_from' | 'export_star' | 'require' | 'dynamic_import' | 'importlib' | 'string_ref';

export interface ImportBinding {
  /** The imported name, `default`, or `*` for a namespace or whole-module binding. */
  imported: string;
  /** The local name it is bound to in this file. */
  local: string;
  /** `import { type X }`, or any binding of an `import type` declaration. */
  type_only: boolean;
}

export interface ImportDecl {
  /** The module as written: `next/headers`, `./lib`, `..models` (Python relative), `app.middleware.Auth` (string ref). */
  spec: string;
  kind: ImportKind;
  line: number;
  type_only: boolean;
  bindings: ImportBinding[];
  /** `export { a as b } from` entries: `b` is exported here, `a` comes from `spec`. */
  reexports: { exported: string; imported: string }[];
  confidence: 'exact' | 'heuristic';
}

export interface ExportEntry {
  exported: string;
  /** The top-level binding in this file that is exported. */
  local: string;
  line: number;
}

export interface SymbolDecl {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

export type RefContext = 'call' | 'new' | 'jsx' | 'type' | 'value';

/** A reference to a top-level binding (an import or a top-level declaration), after scoping. */
export interface Ref {
  binding: string;
  /** The property path read on the binding (`ReactDOM.render` -> `render`; Python `a.b.c` on `a` -> `b.c`), or null. */
  member: string | null;
  line: number;
  end_line: number;
  ctx: RefContext;
  /** The top-level declaration the reference sits in, or null at module level. */
  enclosing: string | null;
  /** True when the expression is directly awaited. */
  awaited: boolean;
}

export interface Unresolved {
  line: number;
  kind: 'import' | 'require' | 'importlib';
  expr: string;
}

export interface ParseError {
  line: number | null;
  message: string;
}

export interface FileFacts {
  imports: ImportDecl[];
  exports: ExportEntry[];
  symbols: SymbolDecl[];
  refs: Ref[];
  unresolved: Unresolved[];
  parse_errors: ParseError[];
}

export interface SyntaxTree {
  readonly lang: Lang;
  /** Repo-relative path with `/` separators. */
  readonly file: string;
  readonly text: string;
}

/** What a resolver may see: the walked files (already boundary- and deny-checked) and a reader for them. */
export interface ResolveContext {
  root: string;
  repoId: string;
  /** Every walked file, repo-relative. Nothing outside this set is ever read or resolved to. */
  files: ReadonlySet<string>;
  /** Package folders from the scan, repo-relative (`''` is the root). */
  packages: readonly { dir: string; ecosystem: 'node' | 'python'; name: string | null; tsconfig: string | null }[];
  /** Reads a walked file through safeRead. */
  readText(rel: string): string;
}

export interface ResolvedImport {
  /** The module as written, or `<spec>.<name>` for a submodule bound by a from-import. */
  to_module: string;
  /** The repo file it resolves to, or null (external, unresolved, or outside the root). */
  to_file: string | null;
  /** For a submodule entry: the binding it came from. */
  binding: string | null;
}

/** Resolves one import of `fromFile`. The first entry is the module itself; later ones are submodules bound by name. */
export type Resolver = (fromFile: string, decl: ImportDecl) => ResolvedImport[];

export interface LanguageAdapter {
  readonly id: string;
  /** Bumped whenever the facts change shape or content, so cached facts are recomputed. */
  readonly version: number;
  readonly lang: Lang;
  readonly extensions: readonly string[];
  /** One-time async setup (WASM loading). */
  init?(): Promise<void>;
  /** The cache key part that changes how a file parses (for example its script kind). */
  scriptKind(file: string): string;
  parse(sp: SafePath): SyntaxTree;
  imports(tree: SyntaxTree): ImportDecl[];
  symbols(tree: SyntaxTree): SymbolDecl[];
  /** All facts in one pass: imports, exports, symbols, references, unresolved dynamic imports, parse errors. */
  facts(tree: SyntaxTree): FileFacts;
  /** Frees parser memory held by the tree (tree-sitter WASM). */
  dispose?(tree: SyntaxTree): void;
  resolver(ctx: ResolveContext): Resolver;
}

/** The file's extension as the adapters match it (`.d.ts` counts as `.ts`). */
export function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}
