// ESLint flat config. The two restricted-import blocks enforce C3 inside the
// engine (src/): only src/security/ may import fs write APIs, and only
// src/security/exec.ts may spawn a process. scripts/ and eval/ are outside the
// engine and are kept out of src/ by the import lint (M3).
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

const fsWriteMessage = 'C3: only src/security/ may write files. Use src/security/safeWrite.ts.';
const spawnMessage = 'C3: only src/security/exec.ts may spawn a process.';

const fsWritePaths = ['fs', 'node:fs'].map((name) => ({
  name,
  importNames: fsWriteApis,
  message: fsWriteMessage,
}));
const fsPromisesWritePaths = ['fs/promises', 'node:fs/promises'].map((name) => ({
  name,
  importNames: fsPromisesWriteApis,
  message: fsWriteMessage,
}));
const spawnPaths = ['child_process', 'node:child_process', 'execa', 'worker_threads', 'node:worker_threads'].map(
  (name) => ({ name, message: spawnMessage }),
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/fixtures/**', 'coverage/**', '.private/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/security/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [...fsWritePaths, ...fsPromisesWritePaths, ...spawnPaths] }],
    },
  },
  {
    files: ['src/security/**/*.ts'],
    ignores: ['src/security/exec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: spawnPaths }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
