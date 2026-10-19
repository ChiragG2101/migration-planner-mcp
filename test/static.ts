// Static import scanning for the single-point tests. Uses the TypeScript
// parser so namespace imports, re-exports, require() and import() are all seen.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { repoRoot } from './helpers.js';

export interface ImportUse {
  file: string;
  module: string;
  names: string[];
  namespaceOrDefault: boolean;
  dynamic: boolean;
}

export function sourceFiles(dir = path.join(repoRoot, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(abs);
  }
  return out.sort();
}

export function relToRepo(abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

export function collectImports(abs: string): ImportUse[] {
  const file = relToRepo(abs);
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  const uses: ImportUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      let nsOrDefault = false;
      if (clause?.name) nsOrDefault = true;
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) nsOrDefault = true;
        else for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
      }
      uses.push({ file, module: node.moduleSpecifier.text, names, namespaceOrDefault: nsOrDefault, dynamic: false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      let all = !node.exportClause;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
      } else if (node.exportClause) all = true;
      uses.push({ file, module: node.moduleSpecifier.text, names, namespaceOrDefault: all, dynamic: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) uses.push({ file, module: expr.text, names: [], namespaceOrDefault: true, dynamic: false });
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isImport) {
        const arg = node.arguments[0];
        uses.push({
          file,
          module: arg && ts.isStringLiteralLike(arg) ? arg.text : '<non-literal>',
          names: [],
          namespaceOrDefault: true,
          dynamic: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

export function allImports(): ImportUse[] {
  return sourceFiles().flatMap(collectImports);
}

/** Lints `code` as if it lived at `relPath` under the repo, with the project's ESLint config. */
export async function lintAs(relPath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}
