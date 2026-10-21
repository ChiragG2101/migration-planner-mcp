// Codemod registry unit tests (M8, C9). Every known ID maps to a pinned entry;
// no free-text command fields exist; argv is built from the template only.
import { describe, expect, it } from 'vitest';
import { getCodemodEntry, buildCodemodArgv, allCodemodEntries } from '../../../src/verify/codemods.js';
import { CODEMOD_IDS } from '../../../src/verify/codemodIds.js';

describe('codemod registry', () => {
  it('every known codemod ID has a registry entry', () => {
    for (const id of CODEMOD_IDS) {
      const entry = getCodemodEntry(id);
      expect(entry, `missing entry for ${id}`).toBeDefined();
    }
  });

  it('every entry has an exact semver version (no ranges)', () => {
    for (const entry of allCodemodEntries()) {
      expect(entry.version, `${entry.id} version should be exact semver`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('every entry has at least one language', () => {
    for (const entry of allCodemodEntries()) {
      expect(entry.languages.length, `${entry.id} has no languages`).toBeGreaterThan(0);
    }
  });

  it('getCodemodEntry returns undefined for unknown IDs', () => {
    expect(getCodemodEntry('not-a-real-id')).toBeUndefined();
    expect(getCodemodEntry('')).toBeUndefined();
    expect(getCodemodEntry('next-codemod:nonexistent')).toBeUndefined();
  });

  it('buildCodemodArgv replaces {sandbox} with the sandbox root', () => {
    const entry = getCodemodEntry('next-codemod:next-async-request-api')!;
    const argv = buildCodemodArgv(entry, '/tmp/sandbox');
    expect(argv).toContain('/tmp/sandbox');
    expect(argv.some((a) => a.includes('{sandbox}'))).toBe(false);
  });

  it('argv_template starts with the runner and package@version', () => {
    for (const entry of allCodemodEntries()) {
      expect(entry.argv_template[0]).toBe(entry.runner);
      expect(entry.argv_template[1]).toBe(`${entry.package}@${entry.version}`);
    }
  });

  it('no entry has a command-like field (no shell strings)', () => {
    for (const entry of allCodemodEntries()) {
      // argv_template must be an array, not a shell string
      expect(Array.isArray(entry.argv_template)).toBe(true);
      // No element should contain shell metacharacters that suggest shell injection
      for (const arg of entry.argv_template) {
        expect(arg, `${entry.id}: shell metachar in argv_template`).not.toMatch(/[;&|`$]/);
      }
    }
  });
});
