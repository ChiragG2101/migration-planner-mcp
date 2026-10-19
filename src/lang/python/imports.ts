// Imports of one Python file: `import a.b`, `from a import b`, relative
// imports, importlib.import_module("literal"), and dotted-path strings that
// may name a module or class (Django settings), recorded as heuristic
// string_ref edges. A non-literal import_module() or __import__() is
// recorded as unresolved, never dropped.
import type { Node } from 'web-tree-sitter';
import type { ImportBinding, ImportDecl, Unresolved } from '../adapter.js';

export const pyLine = (n: Node): number => n.startPosition.row + 1;

const dottedRe = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
// Strings that look dotted but name a file or a host, not a module.
const notModuleTails = new Set([
  'py', 'pyc', 'html', 'htm', 'txt', 'json', 'css', 'js', 'csv', 'xml', 'yml', 'yaml', 'md', 'rst', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'ico', 'pdf', 'zip', 'gz', 'log', 'ini', 'cfg', 'toml', 'sql', 'sqlite3', 'db', 'com', 'org', 'net', 'io',
]);

/** The plain text of a string literal, or null for an f-string, a bytes literal or a concatenation. */
export function pyStringText(n: Node): string | null {
  if (n.type !== 'string') return null;
  const start = n.namedChildren.find((c) => c.type === 'string_start')?.text ?? '';
  if (/[fFbB]/.test(start)) return null;
  const parts = n.namedChildren.filter((c) => c.type !== 'string_start' && c.type !== 'string_end');
  if (parts.some((c) => c.type !== 'string_content')) return null;
  return parts.map((c) => c.text).join('');
}

export function isDottedRef(text: string): boolean {
  if (!dottedRe.test(text)) return false;
  return !notModuleTails.has(text.slice(text.lastIndexOf('.') + 1).toLowerCase());
}

const isModuleLevel = (n: Node): boolean => {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === 'module') return true;
    if (p.type === 'function_definition' || p.type === 'class_definition') return false;
  }
  return true;
};

/** `importlib.import_module`, `import_module` or `__import__` as a callee. */
function isImportlibCall(call: Node): boolean {
  const fn = call.childForFieldName('function');
  if (!fn) return false;
  if (fn.type === 'identifier') return fn.text === 'import_module' || fn.text === '__import__';
  return fn.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'import_module' && fn.childForFieldName('object')?.text === 'importlib';
}

export interface PyImportFacts {
  imports: ImportDecl[];
  unresolved: Unresolved[];
}

export function collectPyImports(root: Node): PyImportFacts {
  const imports: ImportDecl[] = [];
  const unresolved: Unresolved[] = [];
  const decl = (spec: string, kind: ImportDecl['kind'], n: Node, bindings: ImportBinding[] = [], heuristic = false): void => {
    imports.push({ spec, kind, line: pyLine(n), type_only: false, bindings, reexports: [], confidence: heuristic ? 'heuristic' : 'exact' });
  };
  const importlibArgs = new Set<number>();

  const visit = (n: Node): void => {
    if (n.type === 'import_statement') {
      for (const name of n.childrenForFieldName('name')) {
        const dotted = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
        const alias = name.type === 'aliased_import' ? name.childForFieldName('alias')?.text : null;
        if (!dotted) continue;
        const spec = dotted.text;
        // `import a.b` binds `a`; `import a.b as c` binds `c` to a.b.
        const local = alias ?? spec.split('.')[0]!;
        const binding = { imported: '*', local, type_only: false };
        decl(spec, 'import', n, isModuleLevel(n) ? [binding] : []);
      }
    } else if (n.type === 'import_from_statement') {
      const mod = n.childForFieldName('module_name');
      if (mod) {
        const spec = mod.text.replace(/\s+/g, '');
        const bindings: ImportBinding[] = [];
        if (n.namedChildren.some((c) => c.type === 'wildcard_import')) bindings.push({ imported: '*', local: '*', type_only: false });
        for (const name of n.childrenForFieldName('name')) {
          const dotted = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
          const alias = name.type === 'aliased_import' ? name.childForFieldName('alias')?.text : null;
          if (dotted) bindings.push({ imported: dotted.text, local: alias ?? dotted.text, type_only: false });
        }
        decl(spec, 'import', n, isModuleLevel(n) ? bindings : []);
      }
    } else if (n.type === 'call' && isImportlibCall(n)) {
      const arg = n.childForFieldName('arguments')?.namedChildren[0];
      const text = arg ? pyStringText(arg) : null;
      if (arg && text !== null) {
        importlibArgs.add(arg.startIndex);
        decl(text, 'importlib', n);
      } else unresolved.push({ line: pyLine(n), kind: 'importlib', expr: n.text.slice(0, 200) });
    } else if (n.type === 'string' && !importlibArgs.has(n.startIndex)) {
      const text = pyStringText(n);
      if (text !== null && isDottedRef(text)) decl(text, 'string_ref', n, [], true);
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  imports.sort((a, b) => a.line - b.line || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  return { imports, unresolved };
}
