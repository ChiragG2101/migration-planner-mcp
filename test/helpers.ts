// Shared test helpers. Everything a test creates lives in a temp dir that is
// removed after the test file; nothing touches the real home or real repos.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import { PermissionError, type PermissionCode } from '../src/security/errors.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixturesDir = path.join(repoRoot, 'test', 'fixtures');
export const cliEntry = path.join(repoRoot, 'src', 'cli', 'index.ts');

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp dir (realpathed, so macOS /var vs /private/var never matters). */
export function tmpDir(prefix = 'mp-test-'): string {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix));
  made.push(dir);
  return dir;
}

/** Copies a committed fixture into `dest` (default: a new temp dir) and returns its path. */
export function copyFixture(name: string, dest = path.join(tmpDir(), name)): string {
  cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

/** Writes files from a map of relative path to content. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function symlink(target: string, linkPath: string): void {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
}

export function expectPermission(fn: () => unknown, code: PermissionCode): PermissionError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected PermissionError(${code})`).toBeInstanceOf(PermissionError);
  expect((caught as PermissionError).code).toBe(code);
  return caught as PermissionError;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from source in a child process (tests may spawn; the engine may not). */
export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliResult {
  const res = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The args that start the MCP server from source, for the SDK's stdio client. */
export function mcpServerCommand(extra: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: ['--import', 'tsx', cliEntry, 'mcp', ...extra] };
}
