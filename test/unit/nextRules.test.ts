// The drafted Next.js and React rules, promoted only inside this test. The
// loader still skips drafts (D29); this checks the matches and the range.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composePack, type LoadedLibrary } from '../../src/rules/compose.js';
import { bindsTo } from '../../src/rules/match.js';
import { Library, ReleaseFile, Rule } from '../../src/schema/knowledge.js';
import { Pack } from '../../src/schema/pack.js';
import { repoRoot } from '../helpers.js';

function loadPromoted(id: string): LoadedLibrary {
  const dir = path.join(repoRoot, 'knowledge', ...id.split('/'));
  const library = Library.parse(JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')));
  const releases = readdirSync(path.join(dir, 'releases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = ReleaseFile.parse(JSON.parse(readFileSync(path.join(dir, 'releases', f), 'utf8')));
      const rules = file.rules.flatMap((r) => {
        if (!r.match) return [];
        const reviewed = Rule.safeParse({ ...r, status: 'reviewed' as const });
        if (!reviewed.success || reviewed.data.status !== 'reviewed') {
          expect(reviewed.success, r.id).toBe(true);
          return [];
        }
        return [reviewed.data];
      });
      return { release: file.release, rules, events: file.events };
    });
  return { library, releases };
}

const pack = Pack.parse(JSON.parse(readFileSync(path.join(repoRoot, 'packs/nextjs-upgrade/pack.json'), 'utf8')));
const libs = new Map<string, LoadedLibrary>([
  ['npm/next', loadPromoted('npm/next')],
  ['npm/react', loadPromoted('npm/react')],
]);

describe('drafted Next.js rules, as a review would load them', () => {
  it('composes 14.2 to 16 with the async APIs breaking and React 19 required', () => {
    const out = composePack(pack, libs, { installed: { 'npm/next': '14.2.35', 'npm/react': '18.3.1' }, target: '16.0.0', matched: () => true });
    const ids = out.libraries.flatMap((l) => l.rules.map((r) => r.rule.id));
    expect(ids).toEqual(expect.arrayContaining(['next/async-cookies', 'next/the-next-font-package-has-been-fully-removed-in-favor-of-the', 'next/react-19', 'react/removed-reactdom-render']));
    const cookies = out.libraries.flatMap((l) => l.rules).find((r) => r.rule.id === 'next/async-cookies')!;
    expect(cookies.necessity).toBe('breaks');
    expect(out.targets.react).toBe('19.0.0');
    expect(out.targets['react-dom']).toBe('19.0.0');
  });

  it('binds the seeded usage shapes', () => {
    const rules = composePack(pack, libs, { installed: { 'npm/next': '14.2.35', 'npm/react': '18.3.1' }, target: '16.0.0' }).libraries.flatMap((l) => l.rules);
    const binds = (file: string, match_kind: 'call' | 'import' | 'file_convention' | 'config_key' | 'attribute', module: string | null, symbol: string) =>
      rules.some((r) => bindsTo(r.rule.match, { file, match_kind, module, symbol }));
    expect(binds('server/session.ts', 'call', 'next/headers', 'next/headers.cookies')).toBe(true);
    expect(binds('app/[team]/layout.tsx', 'file_convention', 'next', 'params')).toBe(true);
    expect(binds('app/api/feed/route.ts', 'call', null, 'fetch')).toBe(true);
    expect(binds('app/fonts.ts', 'import', '@next/font/google', '@next/font/google')).toBe(true);
    expect(binds('middleware.ts', 'attribute', 'next/server', 'NextRequest.geo')).toBe(true);
    expect(binds('widgets/mount.tsx', 'call', 'react-dom', 'react-dom.render')).toBe(true);
    expect(binds('styles/theme.scss', 'file_convention', null, '~')).toBe(true);
    expect(binds('package.json', 'file_convention', 'next', 'next lint')).toBe(true);
  });
});
