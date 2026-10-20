// ESLint flat config. The restricted-import blocks enforce C3 and C4 inside the
// engine (src/): only src/security/ may import fs write or read APIs (reads
// also in the two allowlisted reads of the engine's own files, D25), and only
// src/security/exec.ts may spawn a process. scripts/ and eval/ are outside the
// engine and are kept out of src/ by the import patterns below (INV-40).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const fsWriteApis = [
  'default',
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
];

const fsPromisesWriteApis = [
  'default',
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rm',
  'rmdir',
  'unlink',
  'rename',
  'copyFile',
  'cp',
  'symlink',
  'link',
  'truncate',
  'open',
  'chmod',
];

// Reads of the repo go through src/security/safeRead.ts (INV-4). Namespace and
// default imports are already refused by the write lists above.
const fsReadApis = [
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
];

const fsPromisesReadApis = ['readFile', 'readdir', 'opendir', 'stat', 'lstat', 'statfs', 'realpath', 'access', 'glob', 'watch'];

/** Each file outside src/security/ that may read its own engine files, and the names it may import (D25). */
const engineFileReads = {
  'src/store/db.ts': ['readdirSync', 'readFileSync'],
  'src/core/engine.ts': ['readFileSync'],
};

const fsWriteMessage = 'C3: only src/security/ may write files. Use src/security/safeWrite.ts.';
const spawnMessage = 'C3: only src/security/exec.ts may spawn a process.';

const fsReadMessage = 'C4: only src/security/ may read files. Use src/security/safeRead.ts with a SafePath.';
const tsSysMessage = 'C4: ts.sys reads files directly. Use a CompilerHost that reads through src/security/safeRead.ts.';

/** The fs restrictions for a file outside src/security/ that may import only the `allowed` read names. */
const fsPaths = (allowed = []) => [
  ...['fs', 'node:fs'].map((name) => ({
    name,
    importNames: [...fsWriteApis, ...fsReadApis.filter((n) => !allowed.includes(n))],
    message: `${fsWriteMessage} ${fsReadMessage}`,
  })),
  ...['fs/promises', 'node:fs/promises'].map((name) => ({
    name,
    importNames: [...fsPromisesWriteApis, ...fsPromisesReadApis],
    message: `${fsWriteMessage} ${fsReadMessage}`,
  })),
  { name: 'typescript', importNames: ['sys'], message: tsSysMessage },
];
const tsSysProperty = { object: 'ts', property: 'sys', message: tsSysMessage };

const spawnPaths = ['child_process', 'node:child_process', 'execa', 'worker_threads', 'node:worker_threads'].map(
  (name) => ({ name, message: spawnMessage }),
);

// INV-40 (C3, C6): the engine never imports the maintainer tools or the eval tooling.
const outsideEnginePatterns = [
  {
    regex: '^(\\.\\./)+(scripts|eval)(/|$)',
    message: 'INV-40: src/ never imports from scripts/ or eval/; they use the network, write files and run git outside the engine.',
  },
];

export default tseslint.config(
  // Seeded-defect repos (eval/seeded/<repo>/) hold deliberately old code; the recall script beside them is linted.
  { ignores: ['dist/**', 'node_modules/**', 'test/fixtures/**', 'eval/seeded/*/**', 'coverage/**', '.private/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/security/**', ...Object.keys(engineFileReads)],
    rules: {
      'no-restricted-imports': ['error', { paths: [...fsPaths(), ...spawnPaths], patterns: outsideEnginePatterns }],
      'no-restricted-properties': ['error', tsSysProperty],
    },
  },
  ...Object.entries(engineFileReads).map(([file, allowed]) => ({
    files: [file],
    rules: {
      'no-restricted-imports': ['error', { paths: [...fsPaths(allowed), ...spawnPaths], patterns: outsideEnginePatterns }],
      'no-restricted-properties': ['error', tsSysProperty],
    },
  })),
  {
    files: ['src/security/**/*.ts'],
    ignores: ['src/security/exec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: spawnPaths, patterns: outsideEnginePatterns }],
    },
  },
  {
    files: ['src/security/exec.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: outsideEnginePatterns }],
    },
  },
  // Gates are deterministic and import no network or model code (M6 acceptance,
  // D37). This is on top of the fs/spawn and outside-engine rules above.
  {
    files: ['src/pipeline/gates/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...fsPaths(), ...spawnPaths],
          patterns: [
            ...outsideEnginePatterns,
            { regex: '(^|/)docs/(context7|cache)(\\.js)?$', message: 'A gate imports no network or docs-fetch code (M6).' },
            { regex: '(^|/)security/network(\\.js)?$', message: 'A gate imports no network code (M6).' },
            { group: ['@modelcontextprotocol/*', 'openai', '@anthropic-ai/*', 'ai'], message: 'A gate imports no model or MCP SDK (C7, M6).' },
          ],
        },
      ],
      'no-restricted-properties': ['error', tsSysProperty],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
