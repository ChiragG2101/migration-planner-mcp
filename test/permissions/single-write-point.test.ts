// INV-2 (C3): only src/security/safeWrite.ts imports a node:fs write API.
import { describe, expect, it } from 'vitest';
import { allImports, lintAs } from '../static.js';

const fsModules = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const writeApis = new Set([
  'promises',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'truncate',
  'truncateSync',
  'open',
  'openSync',
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'chmod',
  'chmodSync',
  'createWriteStream',
]);
const writeFile = 'src/security/safeWrite.ts';

describe('single write point', () => {
  it('no file under src/ except safeWrite.ts imports an fs write API', () => {
    const offenders = allImports().filter(
      (u) => fsModules.has(u.module) && u.file !== writeFile && (u.namespaceOrDefault || u.names.some((n) => writeApis.has(n))),
    );
    expect(offenders).toEqual([]);
  });

  it('the lint rule fails on planted fs writes outside src/security/', async () => {
    expect(await lintAs('src/core/planted.ts', "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', '');\n")).not.toEqual([]);
    expect(await lintAs('src/analysis/planted.ts', "import * as fs from 'fs';\nfs.mkdirSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/planted.ts', "import fs from 'node:fs';\nfs.rmSync('x');\n")).not.toEqual([]);
    expect(await lintAs('src/store/planted.ts', "import { rename } from 'node:fs/promises';\nawait rename('a', 'b');\n")).not.toEqual([]);
    expect(await lintAs('src/cli/planted.ts', "import { createWriteStream } from 'node:fs';\ncreateWriteStream('x');\n")).not.toEqual([]);
    expect(await lintAs('src/tools/planted.ts', "import { promises } from 'node:fs';\npromises.writeFile('x', '');\n")).not.toEqual([]);
  });

  // Reads outside src/security/ are refused since M2 (single-read-point.test.ts).
  it('the lint rule allows fs reads and writes in src/security/', async () => {
    expect(await lintAs('src/security/planted.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n")).toEqual([]);
    expect(await lintAs(writeFile, "import { writeFileSync } from 'node:fs';\nwriteFileSync('x', '');\n")).toEqual([]);
  });
});
