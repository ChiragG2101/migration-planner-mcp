// INV-10 (C9): the pack schema rejects unknown keys (so no command field), a
// missing or malformed trigger, and a library list without exactly one primary.
import { describe, expect, it } from 'vitest';
import { Pack } from '../../src/schema/pack.js';

const pack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'nextjs-upgrade',
  version: '0.1.0',
  kind: 'upgrade',
  language: 'ts',
  trigger: 'Use when planning a Next.js major version upgrade in a TypeScript or JavaScript repo.',
  libraries: [
    { id: 'npm/next', role: 'primary' },
    { id: 'npm/react', role: 'companion' },
  ],
  supported: { from: '14', to: '16' },
  usage_adapter: 'nextjs',
  usage_kinds: [{ kind: 'request_api', lens: 'api' }],
  staging: 'leaf_first',
  checks_hint: 'Run your build and test commands.',
  references: ['react-changes.md'],
  seeded: 'next-tricky',
  ...over,
});

const ok = (x: unknown): boolean => Pack.safeParse(x).success;

describe('pack schema', () => {
  it('accepts a valid pack', () => {
    expect(ok(pack())).toBe(true);
  });

  it('rejects unknown keys, including command-like ones', () => {
    expect(ok(pack({ checks: ['npm test'] }))).toBe(false);
    expect(ok(pack({ install: 'npm ci' }))).toBe(false);
    expect(ok(pack({ libraries: [{ id: 'npm/next', role: 'primary', script: 'x' }] }))).toBe(false);
  });

  it('rejects a missing trigger, or one that does not start with "Use when"', () => {
    const { trigger: _t, ...noTrigger } = pack();
    expect(ok(noTrigger)).toBe(false);
    expect(ok(pack({ trigger: '' }))).toBe(false);
    expect(ok(pack({ trigger: 'Plans Next.js upgrades.' }))).toBe(false);
  });

  it('needs exactly one primary library, each library once', () => {
    expect(ok(pack({ libraries: [{ id: 'npm/react', role: 'companion' }] }))).toBe(false);
    expect(ok(pack({ libraries: [{ id: 'npm/next', role: 'primary' }, { id: 'npm/react', role: 'primary' }] }))).toBe(false);
    expect(ok(pack({ libraries: [{ id: 'npm/next', role: 'primary' }, { id: 'npm/next', role: 'companion' }] }))).toBe(false);
  });

  it('rejects a reference that is not a Markdown file name', () => {
    expect(ok(pack({ references: ['../../etc/passwd'] }))).toBe(false);
    expect(ok(pack({ references: ['run.sh'] }))).toBe(false);
  });

  it('rejects a lens outside the four', () => {
    expect(ok(pack({ usage_kinds: [{ kind: 'request_api', lens: 'combined' }] }))).toBe(false);
  });
});
