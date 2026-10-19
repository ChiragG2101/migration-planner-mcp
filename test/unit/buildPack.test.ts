// Golden output: the same pack data always generates the same files, and a
// draft rule never appears in them.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatedPack } from '../../scripts/lib/build-pack.js';
import { copyFixture, fixturesDir } from '../helpers.js';

function expected(dir: string): Record<string, string> {
  const names = ['SKILL.md', 'references/14.md', 'references/15.md', 'references/codemods.md', 'references/overview.md', 'references/react-changes.md'];
  return Object.fromEntries(names.map((n) => [n, readFileSync(path.join(dir, 'expected', n), 'utf8')]));
}

describe('build:packs', () => {
  it('matches the golden files, stays within the line limit, and omits drafts', () => {
    const root = copyFixture('build-pack');
    const got = generatedPack(root, 'demo');
    expect(got).toEqual(expected(path.join(fixturesDir, 'build-pack')));
    expect(got['SKILL.md']!.split('\n').length).toBeLessThanOrEqual(100);
    expect(got['references/15.md']).not.toContain('skip me');
    expect(generatedPack(root, 'demo')).toEqual(got);
  });

  it('a changed rule title changes the generated reference', () => {
    const root = copyFixture('build-pack');
    const before = generatedPack(root, 'demo')['references/15.md'];
    const file = path.join(root, 'knowledge/npm/main/releases/15.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('cookies are async', 'cookies must be awaited'));
    expect(generatedPack(root, 'demo')['references/15.md']).not.toBe(before);
  });
});
