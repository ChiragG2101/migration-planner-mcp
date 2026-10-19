// Top-level symbols of one TS/JS file, and every reference to a top-level
// binding (an import or a top-level declaration). The checker does the
// scoping, so a local variable that shadows an imported name is not a
// reference to the import.
import ts from 'typescript';
import type { ImportDecl, Ref, RefContext, SymbolDecl } from '../adapter.js';
import { bindingNames, isExported, lineOf } from './imports.js';

const isModuleExportsTarget = (left: ts.Expression): string | null => {
  const isMod = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === 'exports') ||
    (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'module' && e.name.text === 'exports');
  if (isMod(left)) return 'default';
  if (ts.isPropertyAccessExpression(left) && isMod(left.expression)) return left.name.text;
  return null;
};

export function collectSymbols(sf: ts.SourceFile): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const add = (name: string, kind: string, node: ts.Node, exported: boolean): void => {
    out.push({ name, kind, line: lineOf(sf, node), exported });
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) add(stmt.name?.text ?? 'default', 'function', stmt, isExported(stmt));
    else if (ts.isClassDeclaration(stmt)) add(stmt.name?.text ?? 'default', 'class', stmt, isExported(stmt));
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) for (const n of bindingNames(d.name)) add(n, 'variable', d, isExported(stmt));
    } else if (ts.isInterfaceDeclaration(stmt)) add(stmt.name.text, 'interface', stmt, isExported(stmt));
    else if (ts.isTypeAliasDeclaration(stmt)) add(stmt.name.text, 'type', stmt, isExported(stmt));
    else if (ts.isEnumDeclaration(stmt)) add(stmt.name.text, 'enum', stmt, isExported(stmt));
    else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) add(stmt.name.text, 'namespace', stmt, isExported(stmt));
    else if (ts.isExportAssignment(stmt) && !ts.isIdentifier(stmt.expression)) add('default', 'expression', stmt, true);
    else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = isModuleExportsTarget(stmt.expression.left);
      const right = stmt.expression.right;
      if (name && !ts.isIdentifier(right) && !(name === 'default' && ts.isObjectLiteralExpression(right))) {
        add(name, ts.isFunctionLike(right) ? 'function' : 'expression', stmt, true);
      }
    }
  }
  return out;
}

/** The name of the top-level declaration that holds `node`, or null at module level. */
function enclosingName(sf: ts.SourceFile, node: ts.Node): string | null {
  let n: ts.Node = node;
  while (n.parent && n.parent !== sf) n = n.parent;
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return n.name?.text ?? 'default';
  if (ts.isVariableStatement(n)) {
    const d = n.declarationList.declarations.find((x) => x.pos <= node.pos && node.end <= x.end);
    return d ? (bindingNames(d.name)[0] ?? null) : null;
  }
  if (ts.isExportAssignment(n)) return ts.isIdentifier(n.expression) ? n.expression.text : 'default';
  if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) return n.name.text;
  if (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression) && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isModuleExportsTarget(n.expression.left);
  }
  return null;
}

function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) {
      // `class X extends Y` is a value; `implements Y` and interface `extends` are types.
      const clause = n.parent;
      return !(ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(clause.parent));
    }
    if (ts.isTypeNode(n) || ts.isTypeQueryNode(n)) return true;
    if (ts.isStatement(n) || ts.isBlock(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/** A name position that declares or re-exports rather than references. */
function isNamePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportAssignment(p)) return true;
  // A closing JSX tag repeats the opening one.
  if (ts.isJsxClosingElement(p)) return true;
  if (ts.isImportEqualsDeclaration(p)) return p.name === id;
  return 'name' in p && (p as { name?: ts.Node }).name === id && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p);
}

const skipParens = (n: ts.Node): ts.Node => {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p))) p = p.parent;
  return p;
};

export function collectRefs(sf: ts.SourceFile, checker: ts.TypeChecker, imports: readonly ImportDecl[], symbols: readonly SymbolDecl[]): Ref[] {
  const topNames = new Set<string>([...imports.flatMap((d) => d.bindings.map((b) => b.local)), ...symbols.map((s) => s.name)]);
  if (topNames.size === 0) return [];

  // The checker symbol of each top-level binding, found from its declaring identifier.
  const topSymbols = new Map<ts.Symbol, string>();
  const note = (id: ts.Identifier | undefined): void => {
    const sym = id && checker.getSymbolAtLocation(id);
    if (id && sym && topNames.has(id.text)) topSymbols.set(sym, id.text);
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      note(c.name);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) note(c.namedBindings.name);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) note(el.name);
    } else if (ts.isImportEqualsDeclaration(stmt)) note(stmt.name);
    else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) note(stmt.name);
    else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) note(stmt.name);
    else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) note(stmt.name);
    else if (ts.isVariableStatement(stmt)) {
      const visitName = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) note(name);
        else for (const el of name.elements) if (!ts.isOmittedExpression(el)) visitName(el.name);
      };
      for (const d of stmt.declarationList.declarations) visitName(d.name);
    }
  }

  const refs: Ref[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && topNames.has(node.text) && !isNamePosition(node)) {
      const sym = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const binding = sym && topSymbols.get(sym);
      if (binding) refs.push(makeRef(sf, node, binding));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

function makeRef(sf: ts.SourceFile, id: ts.Identifier, binding: string): Ref {
  let outer: ts.Node = id;
  let member: string | null = null;
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === id) {
    member = p.name.text;
    outer = p;
  } else if (ts.isElementAccessExpression(p) && p.expression === id && ts.isStringLiteral(p.argumentExpression)) {
    member = p.argumentExpression.text;
    outer = p;
  } else if (ts.isQualifiedName(p) && p.left === id) {
    member = p.right.text;
    outer = p;
  }
  let ctx: RefContext = 'value';
  let span: ts.Node = outer;
  let awaited = false;
  const parent = skipParens(outer);
  if (inTypePosition(id)) ctx = 'type';
  else if (parent && (ts.isCallExpression(parent) || ts.isTaggedTemplateExpression(parent)) && skipToCallee(parent) === outer) {
    ctx = 'call';
    span = parent;
    awaited = !!skipParens(parent) && ts.isAwaitExpression(skipParens(parent));
  } else if (parent && ts.isNewExpression(parent) && parent.expression === outer) {
    ctx = 'new';
    span = parent;
  } else if (parent && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === outer) {
    ctx = 'jsx';
  }
  return {
    binding,
    member,
    line: lineOf(sf, outer),
    end_line: sf.getLineAndCharacterOfPosition(span.getEnd()).line + 1,
    ctx,
    enclosing: enclosingName(sf, id),
    awaited,
  };
}

/** The callee of a call or tagged template, with parentheses and `!` removed. */
function skipToCallee(call: ts.CallExpression | ts.TaggedTemplateExpression): ts.Node {
  let e: ts.Node = ts.isCallExpression(call) ? call.expression : call.tag;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}
