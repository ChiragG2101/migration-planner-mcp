// Check config unit tests (M8, D44). Checks are frozen at startup; commands
// never come from tool arguments.
import { describe, expect, it } from 'vitest';
import { parseArgv, parseChecksConfig, EMPTY_CHECKS } from '../../../src/verify/checks.js';

describe('parseArgv', () => {
  it('splits a simple command', () => {
    expect(parseArgv('npm test')).toEqual(['npm', 'test']);
  });

  it('handles double-quoted arguments', () => {
    expect(parseArgv('sh -c "npm test"')).toEqual(['sh', '-c', 'npm test']);
  });

  it('handles single-quoted arguments', () => {
    expect(parseArgv("sh -c 'npm test'")).toEqual(['sh', '-c', 'npm test']);
  });

  it('handles backslash escape', () => {
    expect(parseArgv('echo hello\\ world')).toEqual(['echo', 'hello world']);
  });

  it('returns empty array for empty string', () => {
    expect(parseArgv('')).toEqual([]);
  });

  it('handles multiple spaces', () => {
    expect(parseArgv('npm   run   test')).toEqual(['npm', 'run', 'test']);
  });
});

describe('parseChecksConfig', () => {
  it('parses install commands', () => {
    const cfg = parseChecksConfig(['npm ci'], []);
    expect(cfg.install).toHaveLength(1);
    expect(cfg.install[0]!.argv).toEqual(['npm', 'ci']);
  });

  it('parses check commands', () => {
    const cfg = parseChecksConfig([], ['unit=npm test']);
    expect(cfg.checks).toHaveLength(1);
    expect(cfg.checks[0]!.name).toBe('unit');
    expect(cfg.checks[0]!.argv).toEqual(['npm', 'test']);
  });

  it('parses check with quoted command', () => {
    const cfg = parseChecksConfig([], ['unit=sh -c "npm test"']);
    expect(cfg.checks[0]!.argv).toEqual(['sh', '-c', 'npm test']);
  });

  it('throws on missing = in check', () => {
    expect(() => parseChecksConfig([], ['npmtest'])).toThrow(/name=cmd/);
  });

  it('throws on empty install command', () => {
    expect(() => parseChecksConfig(['   '], [])).toThrow(/empty/);
  });

  it('returns frozen config', () => {
    const cfg = parseChecksConfig([], []);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.install)).toBe(true);
    expect(Object.isFrozen(cfg.checks)).toBe(true);
  });

  it('EMPTY_CHECKS has no install or checks', () => {
    expect(EMPTY_CHECKS.install).toHaveLength(0);
    expect(EMPTY_CHECKS.checks).toHaveLength(0);
  });
});
