// Imports and exports of one TS/JS file, as written: ESM imports and
// re-exports (including `export * from` barrels), CommonJS require and
// module.exports, and import() with a literal. A dynamic import or require
// whose argument is not a literal is recorded as unresolved, never dropped.
import ts from 'typescript';
import type { ExportEntry, ImportBinding, ImportDecl, Unresolved } from '../adapter.js';

export interface ImportFacts {
  imports: ImportDecl[];
  exports: ExportEntry[];
  unresolved: Unresolved[];
}

export const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** A string literal or a template with no substitutions; null for anything computed. */
export function literalText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

export const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);
export const isDefaultExport = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.DefaultKeyword);

/** Every identifier a binding pattern declares (`const { a, b: [c] } = ...` -> a, c). */
export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

const isRequireCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1;

/** `module.exports` or `exports`. */
const isModuleExports = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'exports') ||
  (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports');

function requireBindings(name: ts.BindingName, member: string | null): ImportBinding[] {
  if (ts.isIdentifier(name)) return [{ imported: member ?? '*', local: name.text, type_only: false }];
  if (ts.isObjectBindingPattern(name) && member === null) {
    return name.elements.flatMap((el) => {
      if (el.dotDotDotToken || !ts.isIdentifier(el.name)) return [];
      const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      return [{ imported: prop, local: el.name.text, type_only: false }];
    });
  }
  return [];
}

export function collectImports(sf: ts.SourceFile): ImportFacts {
  const imports: ImportDecl[] = [];
  const exports: ExportEntry[] = [];
  const unresolved: Unresolved[] = [];
  const decl = (spec: string, kind: ImportDecl['kind'], node: ts.Node, extra: Partial<ImportDecl> = {}): ImportDecl => {
    const d: ImportDecl = { spec, kind, line: lineOf(sf, node), type_only: false, bindings: [], reexports: [], confidence: 'exact', ...extra };
    imports.push(d);
    return d;
  };
  const requireDecls = new Map<ts.CallExpression, ImportDecl>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = literalText(stmt.moduleSpecifier);
      if (spec === null) continue;
      const clause = stmt.importClause;
      const typeOnly = clause?.isTypeOnly ?? false;
      const bindings: ImportBinding[] = [];
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, type_only: typeOnly });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ imported: '*', local: nb.name.text, type_only: typeOnly });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, type_only: typeOnly || el.isTypeOnly });
        }
      }
      decl(spec, 'import', stmt, { type_only: typeOnly || (bindings.length > 0 && bindings.every((b) => b.type_only)), bindings });
    } else if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const spec = literalText(stmt.moduleReference.expression);
      if (spec !== null) {
        decl(spec, 'require', stmt, { type_only: stmt.isTypeOnly, bindings: [{ imported: '*', local: stmt.name.text, type_only: stmt.isTypeOnly }] });
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const spec = literalText(stmt.moduleSpecifier);
      const clause = stmt.exportClause;
      if (spec !== null) {
        if (!clause) decl(spec, 'export_star', stmt, { type_only: stmt.isTypeOnly });
        else if (ts.isNamespaceExport(clause)) {
          decl(spec, 'export_from', stmt, { type_only: stmt.isTypeOnly, reexports: [{ exported: clause.name.text, imported: '*' }] });
        } else {
          decl(spec, 'export_from', stmt, {
            type_only: stmt.isTypeOnly || (clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)),
            reexports: clause.elements.map((el) => ({ exported: el.name.text, imported: (el.propertyName ?? el.name).text })),
          });
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) exports.push({ exported: el.name.text, local: (el.propertyName ?? el.name).text, line: lineOf(sf, el) });
      }
    } else if (ts.isExportAssignment(stmt)) {
      const local = ts.isIdentifier(stmt.expression) ? stmt.expression.text : 'default';
      exports.push({ exported: 'default', local, line: lineOf(sf, stmt) });
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (isExported(stmt)) {
        const local = stmt.name?.text ?? 'default';
        exports.push({ exported: isDefaultExport(stmt) ? 'default' : local, local, line: lineOf(sf, stmt) });
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (isExported(stmt)) for (const n of bindingNames(d.name)) exports.push({ exported: n, local: n, line: lineOf(sf, d) });
        // Top-level `const x = require('m')`, `const { a } = require('m')`, `const a = require('m').a`.
        const init = d.initializer;
        const call = init && isRequireCall(init) ? init : init && ts.isPropertyAccessExpression(init) && isRequireCall(init.expression) ? init.expression : null;
        const spec = call ? literalText(call.arguments[0]) : null;
        if (call && spec !== null) {
          const member = init && ts.isPropertyAccessExpression(init) ? init.name.text : null;
          requireDecls.set(call, decl(spec, 'require', d, { bindings: requireBindings(d.name, member) }));
        }
      }
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      if (isExported(stmt) && ts.isIdentifier(stmt.name)) exports.push({ exported: stmt.name.text, local: stmt.name.text, line: lineOf(sf, stmt) });
    } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // CommonJS: module.exports = x | { a, b: c }; exports.a = x; module.exports.a = x.
      const { left, right } = stmt.expression;
      if (isModuleExports(left)) {
        if (ts.isIdentifier(right)) exports.push({ exported: 'default', local: right.text, line: lineOf(sf, stmt) });
        else if (ts.isObjectLiteralExpression(right)) {
          for (const p of right.properties) {
            if (ts.isShorthandPropertyAssignment(p)) exports.push({ exported: p.name.text, local: p.name.text, line: lineOf(sf, p) });
            else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isIdentifier(p.initializer)) {
              exports.push({ exported: p.name.text, local: p.initializer.text, line: lineOf(sf, p) });
            }
          }
        } else exports.push({ exported: 'default', local: 'default', line: lineOf(sf, stmt) });
      } else if (ts.isPropertyAccessExpression(left) && isModuleExports(left.expression)) {
        exports.push({ exported: left.name.text, local: ts.isIdentifier(right) ? right.text : left.name.text, line: lineOf(sf, stmt) });
      }
    }
  }

  // require() and import() anywhere in the file: literal ones are edges, others are unresolved.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isImport || isRequireCall(node)) {
        const spec = literalText(node.arguments[0]);
        if (spec === null) {
          unresolved.push({ line: lineOf(sf, node), kind: isImport ? 'import' : 'require', expr: node.getText(sf).slice(0, 200) });
        } else if (!requireDecls.has(node)) {
          decl(spec, isImport ? 'dynamic_import' : 'require', node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  imports.sort((a, b) => a.line - b.line || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  return { imports, exports, unresolved };
}
