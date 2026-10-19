// Top-level symbols of one Python file, and references to module-level
// bindings. tree-sitter gives syntax, not types, so scoping is by name: a
// reference inside a function that assigns or takes a parameter of the same
// name is treated as local. Attribute access through variables stays
// unresolved; the usage adapters label what they derive from these heuristic.
import type { Node } from 'web-tree-sitter';
import type { ImportDecl, Ref, RefContext, SymbolDecl } from '../adapter.js';
import { pyLine } from './imports.js';

/** The definition inside a decorated_definition, or the node itself. */
const unwrap = (n: Node): Node => (n.type === 'decorated_definition' ? (n.childForFieldName('definition') ?? n) : n);

/** Names an assignment target binds: `a`, `a, b`, `(a, [b, c])`. Attributes and subscripts bind nothing. */
function targetNames(n: Node | null): string[] {
  if (!n) return [];
  if (n.type === 'identifier') return [n.text];
  if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list'].includes(n.type)) return n.namedChildren.flatMap(targetNames);
  return [];
}

export function collectPySymbols(root: Node): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  for (const stmt of root.namedChildren) {
    const def = unwrap(stmt);
    if (def.type === 'function_definition' || def.type === 'class_definition') {
      const name = def.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: def.type === 'class_definition' ? 'class' : 'function', line: pyLine(stmt), exported: !name.startsWith('_') });
    } else if (stmt.type === 'expression_statement') {
      const expr = stmt.namedChildren[0];
      if (expr?.type === 'assignment') {
        for (const name of targetNames(expr.childForFieldName('left'))) out.push({ name, kind: 'variable', line: pyLine(stmt), exported: !name.startsWith('_') });
      }
    } else if (stmt.type === 'type_alias_statement') {
      const name = stmt.namedChildren[0]?.text;
      if (name) out.push({ name, kind: 'type', line: pyLine(stmt), exported: true });
    }
  }
  return out;
}

/** Parameter and assignment names local to a function (not counting nested functions). */
function localNames(fn: Node): Set<string> {
  const names = new Set<string>();
  const params = fn.childForFieldName('parameters');
  for (const p of params?.namedChildren ?? []) {
    const id = p.type === 'identifier' ? p : (p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'identifier'));
    if (id?.type === 'identifier') names.add(id.text);
  }
  const visit = (n: Node): void => {
    if (n !== fn && (n.type === 'function_definition' || n.type === 'class_definition' || n.type === 'lambda')) return;
    if (n.type === 'assignment' || n.type === 'augmented_assignment') for (const t of targetNames(n.childForFieldName('left'))) names.add(t);
    if (n.type === 'for_statement') for (const t of targetNames(n.childForFieldName('left'))) names.add(t);
    if (n.type === 'global_statement' || n.type === 'nonlocal_statement') for (const c of n.namedChildren) names.delete(c.text);
    for (const c of n.namedChildren) visit(c);
  };
  const body = fn.childForFieldName('body');
  if (body) visit(body);
  return names;
}

function enclosingName(n: Node): string | null {
  let top: Node = n;
  while (top.parent && top.parent.type !== 'module') top = top.parent;
  const def = unwrap(top);
  if (def.type === 'function_definition' || def.type === 'class_definition') return def.childForFieldName('name')?.text ?? null;
  const expr = top.type === 'expression_statement' ? top.namedChildren[0] : null;
  if (expr?.type === 'assignment') return targetNames(expr.childForFieldName('left'))[0] ?? null;
  return null;
}

/** True for a name that declares rather than references: a def or class name, a parameter, a keyword argument name, an import. */
function isNamePosition(id: Node): boolean {
  const p = id.parent;
  if (!p) return true;
  if ((p.type === 'function_definition' || p.type === 'class_definition') && p.childForFieldName('name')?.startIndex === id.startIndex) return true;
  if (p.type === 'keyword_argument' && p.childForFieldName('name')?.startIndex === id.startIndex) return true;
  if (p.type === 'attribute' && p.childForFieldName('attribute')?.startIndex === id.startIndex) return true;
  if (['parameters', 'default_parameter', 'typed_parameter', 'typed_default_parameter', 'dotted_name', 'aliased_import'].includes(p.type)) return true;
  // An assignment or loop target binds the name.
  let n: Node = id;
  while (n.parent && ['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list'].includes(n.parent.type)) n = n.parent;
  const owner = n.parent;
  if (owner && ['assignment', 'augmented_assignment', 'for_statement'].includes(owner.type)) {
    return owner.childForFieldName('left')?.startIndex === n.startIndex && owner.type !== 'augmented_assignment';
  }
  return false;
}

export function collectPyRefs(root: Node, imports: readonly ImportDecl[], symbols: readonly SymbolDecl[]): Ref[] {
  const topNames = new Set<string>([...imports.flatMap((d) => d.bindings.map((b) => b.local)), ...symbols.map((s) => s.name)]);
  topNames.delete('*');
  if (topNames.size === 0) return [];
  const localsCache = new Map<number, Set<string>>();
  const shadowed = (id: Node): boolean => {
    for (let p = id.parent; p; p = p.parent) {
      if (p.type === 'function_definition' || p.type === 'lambda') {
        let locals = localsCache.get(p.startIndex);
        if (!locals) localsCache.set(p.startIndex, (locals = p.type === 'lambda' ? new Set() : localNames(p)));
        if (locals.has(id.text)) return true;
      }
    }
    return false;
  };
  const refs: Ref[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'import_statement' || n.type === 'import_from_statement') return;
    if (n.type === 'identifier' && topNames.has(n.text) && !isNamePosition(n) && !shadowed(n)) refs.push(makeRef(n));
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return refs;
}

function makeRef(id: Node): Ref {
  // Climb `a.b.c` so the member path is `b.c` and the span is the whole chain.
  let outer = id;
  const path: string[] = [];
  while (outer.parent?.type === 'attribute' && outer.parent.childForFieldName('object')?.startIndex === outer.startIndex) {
    const attr = outer.parent.childForFieldName('attribute');
    if (attr) path.push(attr.text);
    outer = outer.parent;
  }
  let ctx: RefContext = 'value';
  let span = outer;
  let awaited = false;
  const parent = outer.parent;
  let inType = false;
  for (let p = id.parent; p && !inType; p = p.parent) if (p.type === 'type') inType = true;
  if (inType) ctx = 'type';
  else if (parent?.type === 'call' && parent.childForFieldName('function')?.startIndex === outer.startIndex) {
    ctx = 'call';
    span = parent;
    awaited = parent.parent?.type === 'await';
  } else if (parent?.type === 'decorator') ctx = 'call';
  return {
    binding: id.text,
    member: path.length ? path.join('.') : null,
    line: pyLine(outer),
    end_line: span.endPosition.row + 1,
    ctx,
    enclosing: enclosingName(id),
    awaited,
  };
}
