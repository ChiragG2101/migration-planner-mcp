// INV-4, INV-5 (C4) inside the parsers: neither the TS CompilerHost nor the
// Python adapter reads outside the root, and a deny-listed file is never
// parsed, even when the repo imports it. Each planted file declares a token
// that appears nowhere else and calls a request API, so parsing it would show
// up in the symbols, the usages or the facts cache.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir, writeTree } from '../helpers.js';
import { build, type Built } from '../usages.js';

const TOKEN = 'SECRET_BODY_TOKEN';
const marker = `import { cookies } from 'next/headers';\nfunction ${TOKEN}() { return cookies(); }\nexport default ${TOKEN};\n`;

function neverParsed(b: Built): void {
  expect(b.symbols.map((s) => s.name)).not.toContain(TOKEN);
  for (const json of b.cache.values()) expect(json).not.toContain(TOKEN);
}

describe('parsers stay inside the root', () => {
  it('a tsconfig paths entry pointing at ../outside resolves to nothing and the target is never read', async () => {
    const base = tmpDir();
    writeTree(path.join(base, 'outside'), { 'secret.ts': marker });
    const b = await build(
      {
        'package.json': JSON.stringify({ name: 'app', dependencies: { next: '14.2.35' } }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@out/*': ['../outside/*'] }, rootDir: '..' } }),
        'app/page.tsx': "import a from '@out/secret';\nimport b from '../outside/secret';\nexport default function Page() { return a() + b(); }\n",
      },
      { root: path.join(base, 'repo') },
    );
    expect(b.imports.filter((i) => i.from_file === 'app/page.tsx').map((i) => i.to_file)).toEqual([null, null]);
    neverParsed(b);
  });

  it('a Python relative import that climbs above the root resolves to nothing and the target is never read', async () => {
    const base = tmpDir();
    writeTree(path.join(base, 'outside'), { 'secret.py': `def ${TOKEN}():\n    pass\n` });
    const b = await build(
      { 'pkg/__init__.py': '', 'pkg/mod.py': 'from ...outside import secret\nfrom ..outside.secret import thing\n' },
      { root: path.join(base, 'repo') },
    );
    expect(b.imports.filter((i) => i.from_file === 'pkg/mod.py').map((i) => i.to_file)).toEqual([null, null]);
    expect(b.symbols.map((s) => s.name)).not.toContain(TOKEN);
    for (const json of b.cache.values()) expect(json).not.toContain(TOKEN);
  });

  it('a deny-listed file the code imports is never parsed', async () => {
    const b = await build(
      {
        'package.json': JSON.stringify({ name: 'app', dependencies: { next: '14.2.35' } }),
        'app/.env.local.ts': marker,
        'app/id_rsa.ts': marker,
        'app/page.tsx': "import a from './.env.local';\nimport k from './id_rsa';\nexport default function Page() { return a() + k(); }\n",
        'py/.env.py': `def ${TOKEN}():\n    pass\n`,
        'py/use.py': 'from .env import thing\n',
      },
      {},
    );
    expect(b.imports.filter((i) => i.from_file === 'app/page.tsx').map((i) => i.to_file)).toEqual([null, null]);
    expect(b.imports.filter((i) => i.from_file === 'py/use.py').map((i) => i.to_file)).toEqual([null]);
    neverParsed(b);
  });

  it('a symlink inside the repo pointing outside is never parsed', async () => {
    const base = tmpDir();
    writeTree(path.join(base, 'outside'), { 'secret.ts': marker });
    const root = path.join(base, 'repo');
    writeTree(root, { 'package.json': JSON.stringify({ name: 'app', dependencies: { next: '14.2.35' } }) });
    const { symlink } = await import('../helpers.js');
    symlink(path.join(base, 'outside', 'secret.ts'), path.join(root, 'lib', 'secret.ts'));
    const b = await build({ 'app/page.tsx': "import a from '../lib/secret';\na();\n" }, { root });
    expect(b.imports.find((i) => i.from_file === 'app/page.tsx')?.to_file).toBeNull();
    neverParsed(b);
  });
});
