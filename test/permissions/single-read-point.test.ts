// INV-4 (C4): the repo is read only through src/security/safeRead.ts. No file
// under src/ outside src/security/ imports a node:fs read API, except the two
// reads of the engine's own files (docs/design.md D25), and nothing reads
// through ts.sys.
import { describe, expect, it } from 'vitest';
import { allImports, lintAs } from '../static.js';

const fsModules = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const readApis = new Set([
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'statfs',
  'statfsSync',
  'realpath',
  'realpathSync',
  'exists',
  'existsSync',
  'access',
  'accessSync',
  'createReadStream',
  'openAsBlob',
  'read',
  'readSync',
  'readv',
  'readvSync',
  'glob',
  'globSync',
  'watch',
  'watchFile',
  'open',
  'openSync',
]);

/** The allowlist recorded in docs/design.md D25: file -> the read names it may import. */
const engineFileReads: Record<string, string[]> = {
  'src/store/db.ts': ['readdirSync', 'readFileSync'],
  'src/core/engine.ts': ['readFileSync'],
};

describe('single read point', () => {
  it('no file under src/ outside src/security/ imports an fs read API, beyond the allowlist', () => {
    const offenders = allImports().filter((u) => {
      if (!fsModules.has(u.module) || u.file.startsWith('src/security/')) return false;
      if (u.namespaceOrDefault) return true;
      const allowed = engineFileReads[u.file] ?? [];
      return u.names.some((n) => readApis.has(n) && !(u.module.endsWith('fs') && allowed.includes(n)));
    });
    expect(offenders).toEqual([]);
  });

  it('no file under src/ imports ts.sys', () => {
    expect(allImports().filter((u) => u.module === 'typescript' && u.names.includes('sys'))).toEqual([]);
  });

  it('the lint rule fails on planted reads in src/lang/ and elsewhere outside src/security/', async () => {
    expect(await lintAs('src/lang/planted.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/lang/ts/planted.ts', "import { existsSync, statSync } from 'fs';\nexistsSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/lang/python/planted.ts', "import { readFile } from 'node:fs/promises';\nawait readFile('x');\n")).not.toEqual([]);
    expect(await lintAs('src/analysis/planted.ts', "import { readdirSync } from 'node:fs';\nreaddirSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/core/planted.ts', "import { createReadStream } from 'node:fs';\ncreateReadStream('x');\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/planted.ts', "import { realpathSync } from 'node:fs';\nrealpathSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/lang/planted.ts', "import * as fs from 'node:fs';\nfs.readFileSync('x');\n")).not.toEqual([]);
  });

  it('the lint rule fails on ts.sys outside src/security/', async () => {
    expect(await lintAs('src/lang/ts/planted.ts', "import ts from 'typescript';\nts.sys.readFile('x');\n", 'no-restricted-properties')).not.toEqual([]);
    expect(await lintAs('src/lang/ts/planted.ts', "import { sys } from 'typescript';\nsys.readFile('x');\n")).not.toEqual([]);
  });

  it('the allowlisted files may import only their own read names', async () => {
    expect(await lintAs('src/store/db.ts', "import { readdirSync, readFileSync } from 'node:fs';\nreaddirSync(readFileSync('x', 'utf8'));\n")).toEqual([]);
    expect(await lintAs('src/core/engine.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n")).toEqual([]);
    expect(await lintAs('src/core/engine.ts', "import { statSync } from 'node:fs';\nstatSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/store/db.ts', "import { createReadStream } from 'node:fs';\ncreateReadStream('x');\n")).not.toEqual([]);
  });

  it('the lint rule allows reads in src/security/', async () => {
    expect(await lintAs('src/security/planted.ts', "import { readFileSync, statSync } from 'node:fs';\nstatSync(readFileSync('x', 'utf8'));\n")).toEqual([]);
  });
});
