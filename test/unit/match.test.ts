// D30: how a rule's match binds to a usage. The usages are shaped exactly as
// the Next.js adapter reports them on next-tricky.
import { describe, expect, it } from 'vitest';
import { bindsTo, globToRegExp, type MatchableUsage } from '../../src/rules/match.js';
import type { Match } from '../../src/schema/match.js';

const u = (file: string, match_kind: MatchableUsage['match_kind'], module: string | null, symbol: string): MatchableUsage => ({ file, match_kind, module, symbol });

const cookies = u('server/session.ts', 'call', 'next/headers', 'next/headers.cookies');
const fetchCall = u('app/api/feed/route.ts', 'call', null, 'fetch');
const font = u('app/fonts.ts', 'import', '@next/font/google', '@next/font/google');
const refType = u('components/useFocus.ts', 'import', 'react', 'react.MutableRefObject');
const geo = u('middleware.ts', 'attribute', 'next/server', 'NextRequest.geo');
const domains = u('next.config.js', 'config_key', 'next.config', 'images.domains');
const images = u('next.config.js', 'config_key', 'next.config', 'images');
const runtime = u('app/edge/page.tsx', 'config_key', 'segment', 'runtime');
const params = u('app/[team]/layout.tsx', 'file_convention', 'next', 'params');
const dep = u('package.json', 'dependency', '@next/font', '@next/font');
const peer = u('package-lock.json', 'dependency', 'react', 'legacy-modal@1.4.0 peer react@^16.8.0 || ^17.0.0 || ^18.0.0');
const dynamic = u('app/plugins/page.tsx', null, null, 'import(`../../plugins/${name}`)');

describe('bindsTo', () => {
  it.each<[string, Match, MatchableUsage, boolean]>([
    ['call by module and name', { kind: 'call', module: 'next/headers', name: 'cookies' }, cookies, true],
    ['call with another name', { kind: 'call', module: 'next/headers', name: 'headers' }, cookies, false],
    ['call with another module', { kind: 'call', module: 'next/server', name: 'cookies' }, cookies, false],
    ['a global call has a null module', { kind: 'call', module: null, name: 'fetch' }, fetchCall, true],
    ['a module call does not bind a global', { kind: 'call', module: 'node-fetch', name: 'fetch' }, fetchCall, false],
    ['a global rule does not bind a call with a module', { kind: 'call', module: null, name: 'fetch' }, u('lib/api.ts', 'call', 'node-fetch', 'fetch'), false],
    ['import of a package binds its subpaths', { kind: 'import', module: '@next/font' }, font, true],
    ['import does not bind a look-alike package', { kind: 'import', module: '@next/fo' }, font, false],
    ['import with a name binds that name', { kind: 'import', module: 'react', name: 'MutableRefObject' }, refType, true],
    ['import with another name', { kind: 'import', module: 'react', name: 'RefObject' }, refType, false],
    ['attribute by module and path', { kind: 'attribute', module: 'next/server', path: 'NextRequest.geo' }, geo, true],
    ['attribute with another path', { kind: 'attribute', module: 'next/server', path: 'NextRequest.ip' }, geo, false],
    ['config key binds itself', { kind: 'config_key', file_kind: 'next.config', path: 'images.domains' }, domains, true],
    ['config key binds its descendants', { kind: 'config_key', file_kind: 'next.config', path: 'images' }, domains, true],
    ['config key does not bind its parent', { kind: 'config_key', file_kind: 'next.config', path: 'images.domains' }, images, false],
    ['config key does not bind a look-alike', { kind: 'config_key', file_kind: 'next.config', path: 'image' }, images, false],
    ['segment config is its own file kind', { kind: 'config_key', file_kind: 'segment', path: 'runtime' }, runtime, true],
    ['next.config does not bind segment config', { kind: 'config_key', file_kind: 'next.config', path: 'runtime' }, runtime, false],
    ['file convention by glob and symbol', { kind: 'file_convention', glob: 'app/**/{page,layout}.{js,jsx,ts,tsx}', symbol: 'params' }, params, true],
    ['file convention with another symbol', { kind: 'file_convention', glob: 'app/**/{page,layout}.{js,jsx,ts,tsx}', symbol: 'searchParams' }, params, false],
    ['file convention outside the glob', { kind: 'file_convention', glob: 'pages/**/*.tsx', symbol: 'params' }, params, false],
    ['dependency by package', { kind: 'dependency', package: '@next/font', range: '*' }, dep, true],
    ['a peer range on react binds react', { kind: 'dependency', package: 'react', range: '<19' }, peer, true],
    ['dependency on another package', { kind: 'dependency', package: 'react-dom', range: '*' }, peer, false],
    ['the match kind must agree', { kind: 'import', module: 'next/headers' }, cookies, false],
  ])('%s', (_label, m, usage, want) => {
    expect(bindsTo(m, usage)).toBe(want);
  });

  it('an unresolved dynamic import binds no rule', () => {
    const all: Match[] = [
      { kind: 'import', module: 'x' },
      { kind: 'call', module: null, name: 'import' },
      { kind: 'file_convention', glob: '**/*.tsx' },
    ];
    expect(all.some((m) => bindsTo(m, dynamic))).toBe(false);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['app/**/page.tsx', 'app/page.tsx', true],
    ['app/**/page.tsx', 'app/a/b/page.tsx', true],
    ['app/**/page.tsx', 'src/app/a/page.tsx', true],
    ['app/**/page.tsx', 'apps/web/app/page.tsx', true],
    ['app/**/page.tsx', 'myapp/page.tsx', false],
    ['app/*.tsx', 'app/a/page.tsx', false],
    ['**/*.{scss,sass}', 'styles/theme.scss', true],
    ['**/*.{scss,sass}', 'styles/theme.css', false],
    ['middleware.{js,ts}', 'middleware.ts', true],
    ['middleware.{js,ts}', 'src/middleware.ts', true],
    ['middleware.{js,ts}', 'not-middleware.ts', false],
    ['app/[team]/layout.tsx', 'app/[team]/layout.tsx', true],
    ['app/[team]/layout.tsx', 'app/t/layout.tsx', false],
    ['a.b', 'axb', false],
  ])('%s against %s is %s', (glob, file, want) => {
    expect(globToRegExp(glob).test(file)).toBe(want);
  });
});
