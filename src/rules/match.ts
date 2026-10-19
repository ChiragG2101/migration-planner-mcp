// Binds a rule's typed `match` to the usages find_usages reported (D30). A
// usage binds when its match_kind equals the match's kind and its module and
// symbol fit the match; the usage adapter writes symbols as `<module>.<name>`
// for imports and calls, the dotted path for attributes and config keys, and
// the package for dependencies. Value-level detail (which `runtime` value, a
// declared dependency range) is not checked, so a usage already in the target
// form still binds; a lens marks it out of scope (D16).
import type { Match } from '../schema/match.js';
import type { Usage } from '../schema/usage.js';

export type MatchableUsage = Pick<Usage, 'file' | 'match_kind' | 'module' | 'symbol'>;

const isOrUnder = (value: string, base: string, sep: string): boolean => value === base || value.startsWith(base + sep);

/**
 * A glob as a regular expression over repo-relative paths. It is anchored at a
 * path-segment boundary, as if it began with `**\/`, so `app/**\/page.tsx`
 * also finds `src/app/x/page.tsx` and `apps/web/app/page.tsx`. Supports `**`,
 * `*`, `?` and `{a,b}`; everything else (including `[` and `(` in Next.js
 * route folders) is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:[^/]+/)*' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$|()[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)${re}$`);
}

export function bindsTo(m: Match, u: MatchableUsage): boolean {
  if (u.match_kind !== m.kind) return false;
  switch (m.kind) {
    case 'import':
      if (u.module === null || !isOrUnder(u.module, m.module, '/')) return false;
      return m.name === undefined || u.symbol === `${u.module}.${m.name}`;
    case 'call':
      return u.module === m.module && u.symbol === (m.module === null ? m.name : `${m.module}.${m.name}`);
    case 'attribute':
      return u.module === m.module && u.symbol === m.path;
    case 'config_key':
      return u.module === m.file_kind && isOrUnder(u.symbol, m.path, '.');
    case 'dependency':
      return u.module === m.package;
    case 'file_convention':
      return globToRegExp(m.glob).test(u.file) && (m.symbol === undefined || u.symbol === m.symbol);
    case 'setting':
      return u.symbol === m.name;
    case 'string_ref':
      return u.symbol === m.dotted_path;
    case 'template_tag':
    case 'template_filter':
      return u.symbol === m.name;
  }
}
