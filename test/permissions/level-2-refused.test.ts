// INV-6 (C5): --level 2 is refused as "not built in v0.1", by the CLI and the MCP adapter.
import { describe, expect, it } from 'vitest';
import { NotBuiltError } from '../../src/security/errors.js';
import { parseLevel } from '../../src/security/level.js';
import { copyFixture, runCli, tmpDir } from '../helpers.js';

describe('--level 2', () => {
  it('parseLevel refuses 2 with the not-built message', () => {
    expect(() => parseLevel('2')).toThrow(NotBuiltError);
    expect(() => parseLevel('2')).toThrow('--level 2 is not built in v0.1');
    expect(parseLevel(undefined)).toBe(0);
    expect(parseLevel('1')).toBe(1);
  });

  it('scan --level 2 exits non-zero with the not-built message', () => {
    const repo = copyFixture('next-basic');
    const res = runCli(['scan', repo, '--source', 'next', '--target', 'next@15.1.0', '--out', tmpDir(), '--level', '2']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('not built in v0.1');
    expect(res.stdout).toBe('');
  });

  it('mcp --level 2 exits non-zero with the not-built message', () => {
    const res = runCli(['mcp', '--level', '2']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('not built in v0.1');
  });
});

describe('the level is set once', () => {
  it('cannot be changed after startup', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const level = await import('../../src/security/level.js');
    level.initLevel(0);
    level.initLevel(0);
    expect(() => level.initLevel(1)).toThrow('cannot change');
    expect(level.currentLevel()).toBe(0);
  });
});
