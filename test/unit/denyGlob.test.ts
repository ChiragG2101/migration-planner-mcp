// D58: user deny globs are matched without a regex. The matcher must give the
// same answers the regex gave, so this file keeps a frozen copy of it.
import { describe, expect, it } from 'vitest';
import { compileDenyGlob, matchDenyGlob } from '../../src/security/denyList.js';

/** The regex compiler denyList.ts used before D58's matcher. Do not change it. */
function oldGlobToRegExp(glob: string): RegExp {
  const dir = glob.endsWith('/');
  const trimmed = glob.replace(/\/+$/, '').replace(/^\.\//, '');
  const body = trimmed
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  const anywhere = !trimmed.includes('/') ? '(?:.*/)?' : '';
  return new RegExp(`^${anywhere}${body}${dir ? '(?:/.*)?' : ''}$`);
}

const globs = [
  'secrets/**',
  '**/*.pem',
  'planner-kept/**',
  'foo/',
  '*.log',
  './x/y',
  'a?b.txt',
  'conf.d/*.ini',
  'src/**/gen/**',
  '***',
  'x/*',
  '[ab](c)+$^{1}|\\.txt',
];

const paths = [
  'secrets/a.txt',
  'secrets/deep/b.txt',
  'secrets',
  'not-secrets/a.txt',
  'certs/server.pem',
  'server.pem',
  'a/b/c.pem',
  'planner-kept/secret.txt',
  'foo',
  'foo/bar',
  'foo/bar/baz.ts',
  'a/foo/bar',
  'foobar',
  'app.log',
  'logs/app.log',
  'app.log.1',
  'x/y',
  'x/y/z',
  './x/y',
  'a?b.txt',
  'aXb.txt',
  'conf.d/a.ini',
  'confXd/a.ini',
  'src/a/gen/b.ts',
  'src/gen/b.ts',
  'x/a',
  'x/a/b',
  '[ab](c)+$^{1}|\\.txt',
  'ac.txt',
  'foo/bar\nbaz',
  'a\n/foo',
  'secrets/a\nb',
  'x/a\nb',
  '',
];

describe('deny glob matcher', () => {
  it('gives the old regex answer on ordinary globs and paths', () => {
    for (const glob of globs) {
      const re = oldGlobToRegExp(glob);
      const g = compileDenyGlob(glob);
      for (const p of paths) expect(matchDenyGlob(g, p), `${glob} on ${JSON.stringify(p)}`).toBe(re.test(p));
    }
  });

  it('gives the old regex answer on every short glob and path over a small alphabet', () => {
    // Small enough that the old regex stays fast. Covers `*`, `**`, `/`, a
    // literal `.` and `?`, a leading `./` and a trailing `/`.
    const all = (alphabet: string[], max: number): string[] => {
      const out = [''];
      let layer = [''];
      for (let len = 1; len <= max; len++) {
        layer = layer.flatMap((s) => alphabet.map((c) => s + c));
        out.push(...layer);
      }
      return out;
    };
    const shortGlobs = all(['a', '*', '/', '.', '?'], 4);
    const shortPaths = all(['a', 'b', '/', '.', '\n'], 4);
    let checked = 0;
    for (const glob of shortGlobs) {
      const re = oldGlobToRegExp(glob);
      const g = compileDenyGlob(glob);
      for (const p of shortPaths) {
        if (matchDenyGlob(g, p) !== re.test(p)) throw new Error(`${JSON.stringify(glob)} on ${JSON.stringify(p)}`);
        checked++;
      }
    }
    expect(checked).toBe(shortGlobs.length * shortPaths.length);
  });
});
