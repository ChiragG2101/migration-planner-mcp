// The TS/JS language adapter: imports and re-export chains, require and ESM
// interop, tsconfig paths, JSX, scoping, and dynamic imports recorded as
// unresolved.
import { describe, expect, it } from 'vitest';
import type { Origin } from '../../../src/lang/graph.js';
import { build } from '../../usages.js';

const edges = (b: Awaited<ReturnType<typeof build>>, from: string): string[] =>
  b.imports.filter((i) => i.from_file === from).map((i) => `${i.kind} ${i.to_module} -> ${i.to_file ?? 'null'}`);

const where = (o: Origin): string => (o.kind === 'local' ? `${o.file}#${o.name}` : o.kind === 'external' ? `${o.module}.${o.name}` : o.kind);

describe('TS adapter: imports and re-exports', () => {
  it('follows re-export chains of depth 1 to 3, through named re-exports and export *', async () => {
    const b = await build({
      'src/a.ts': 'export function f() { return 1; }\n',
      'src/b.ts': "export { f } from './a';\n",
      'src/c.ts': "export * from './b';\n",
      'src/d.ts': "export { f as g } from './c';\n",
      'src/use.ts': "import { f as f1 } from './b';\nimport { f as f2 } from './c';\nimport { g } from './d';\nf1(); f2(); g();\n",
    });
    const g = b.ctx.graph;
    const o1 = g.resolveLocal('src/use.ts', 'f1');
    const o2 = g.resolveLocal('src/use.ts', 'f2');
    const o3 = g.resolveLocal('src/use.ts', 'g');
    expect([o1, o2, o3].map(where)).toEqual(['src/a.ts#f', 'src/a.ts#f', 'src/a.ts#f']);
    expect([o1, o2, o3].map((o) => o.hops.length)).toEqual([1, 2, 3]);
    expect(o3.hops.map((h) => h.file)).toEqual(['src/d.ts', 'src/c.ts', 'src/b.ts']);
    expect(edges(b, 'src/c.ts')).toEqual(['export_star ./b -> src/b.ts']);
  });

  it('resolves a re-export of an external module to that module', async () => {
    const b = await build({
      'lib/index.ts': "export { cookies } from 'next/headers';\nexport * from 'next/cache';\n",
      'app.ts': "import { cookies, revalidateTag } from './lib';\ncookies(); revalidateTag('x');\n",
    });
    expect(where(b.ctx.graph.resolveLocal('app.ts', 'cookies'))).toBe('next/headers.cookies');
    expect(where(b.ctx.graph.resolveLocal('app.ts', 'revalidateTag'))).toBe('next/cache.revalidateTag');
  });

  it('handles require and ESM interop', async () => {
    const b = await build({
      'cjs.js': 'module.exports = function helper() {};\nexports.named = function () {};\n',
      'obj.js': 'function one() {}\nfunction two() {}\nmodule.exports = { one, renamed: two };\n',
      'use.js':
        "const helper = require('./cjs');\nconst { one, renamed } = require('./obj');\nconst mod = require('./obj');\nconst named = require('./cjs').named;\n" +
        "import def from './cjs';\nhelper(); one(); renamed(); mod.one(); named(); def();\n",
    });
    const g = b.ctx.graph;
    expect(where(g.resolveLocal('use.js', 'one'))).toBe('obj.js#one');
    expect(where(g.resolveLocal('use.js', 'renamed'))).toBe('obj.js#two');
    expect(where(g.resolveLocal('use.js', 'named'))).toBe('cjs.js#named');
    expect(where(g.resolveLocal('use.js', 'def'))).toBe('cjs.js#default');
    const modRef = b.ctx.facts('use.js')!.refs.find((r) => r.binding === 'mod')!;
    expect(where(g.refOrigin('use.js', modRef))).toBe('obj.js#one');
    expect(edges(b, 'use.js')).toContain('require ./obj -> obj.js');
  });

  it('resolves tsconfig paths aliases, and a workspace package imported by name', async () => {
    const b = await build({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', main: 'index.ts' }),
      'packages/ui/index.ts': 'export const Button = 1;\n',
      'packages/web/package.json': JSON.stringify({ name: 'web' }),
      'packages/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/web/src/lib/x.ts': 'export const x = 1;\n',
      'packages/web/src/page.tsx': "import { x } from '@/lib/x';\nimport { Button } from '@acme/ui';\nexport default () => <div>{x}{Button}</div>;\n",
    });
    expect(edges(b, 'packages/web/src/page.tsx')).toEqual([
      'import @/lib/x -> packages/web/src/lib/x.ts',
      'import @acme/ui -> packages/ui/index.ts',
    ]);
  });

  it('parses JSX and TSX, and records component tags as jsx references', async () => {
    const b = await build({
      'Button.jsx': 'export function Button() { return <button />; }\n',
      'page.tsx': "import { Button } from './Button';\nexport default function Page() { return <Button></Button>; }\n",
    });
    const refs = b.ctx.facts('page.tsx')!.refs.filter((r) => r.binding === 'Button');
    expect(refs.map((r) => r.ctx)).toEqual(['jsx']);
    expect(b.summary.unparsed_files).toEqual([]);
  });

  it('records a dynamic import or require with a non-literal argument as unresolved, never as an edge', async () => {
    const b = await build({
      'load.ts': "const name = './x';\nexport const a = import(name);\nexport const b = require(name);\nexport const c = import(`./lit`);\n",
      'lit.ts': 'export {};\n',
    });
    expect(b.summary.unresolved_dynamic).toEqual([
      { file: 'load.ts', line: 2, kind: 'import', expr: 'import(name)' },
      { file: 'load.ts', line: 3, kind: 'require', expr: 'require(name)' },
    ]);
    expect(edges(b, 'load.ts')).toEqual(['dynamic_import ./lit -> lit.ts']);
  });

  it('scopes references: a local that shadows an import is not a reference to it', async () => {
    const b = await build({
      'a.ts': "import { cookies } from 'next/headers';\nfunction f(cookies: number) { return cookies; }\nfunction g() { const cookies = 2; return cookies; }\nexport const h = () => cookies();\n",
    });
    const refs = b.ctx.facts('a.ts')!.refs.filter((r) => r.binding === 'cookies');
    expect(refs.map((r) => [r.line, r.ctx, r.enclosing])).toEqual([[4, 'call', 'h']]);
  });

  it('lists a file with syntax errors as unparsed, keeps its recovered facts and finishes the run', async () => {
    const b = await build({ 'bad.ts': "import { a } from './ok';\nexport function broken( {\n", 'ok.ts': 'export const a = 1;\n' });
    expect(b.summary.unparsed_files).toMatchObject([{ file: 'bad.ts', lang: 'ts', partial: true }]);
    expect(edges(b, 'bad.ts')).toEqual(['import ./ok -> ok.ts']);
  });

  it('records type-only imports and type references', async () => {
    const b = await build({ 'a.ts': "import type { Metadata } from 'next';\nimport { type Foo, bar } from './b';\nexport const m: Metadata = {};\n", 'b.ts': 'export type Foo = 1;\nexport const bar = 1;\n' });
    const f = b.ctx.facts('a.ts')!;
    expect(f.imports.map((d) => [d.spec, d.type_only, d.bindings.map((x) => x.type_only)])).toEqual([
      ['next', true, [true]],
      ['./b', false, [true, false]],
    ]);
    expect(f.refs.find((r) => r.binding === 'Metadata')?.ctx).toBe('type');
  });
});
