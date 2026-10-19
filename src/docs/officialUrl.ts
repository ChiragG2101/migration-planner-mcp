// The one check for "this URL is an official doc" (docs/design.md D9, D14).
// The pack lint uses it on every rule's `source`, and M4 uses it to compute a
// doc's `official` label, so a source the lint accepts is always official.
// The URL is normalised first (lowercase scheme and host, no default port,
// `..` and `%2e%2e` resolved) and must be https:// with no credentials; then
// it must start with one of the library's doc_sources prefixes, each of which
// ends in `/`, so a look-alike host or a sibling repo never matches.

/** The normalised form of an https:// URL with no credentials, or null. */
export function normalizeDocUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  return u.href;
}

/** Why a doc_sources prefix is unusable, or null when it is fine. */
export function docSourceProblem(prefix: string): string | null {
  const n = normalizeDocUrl(prefix);
  if (n === null) return `doc source ${prefix} is not an https:// URL without credentials`;
  if (!prefix.endsWith('/') || !n.endsWith('/')) return `doc source ${prefix} must end in /`;
  if (n.includes('?') || n.includes('#')) return `doc source ${prefix} must not carry a query or fragment`;
  return null;
}

/** True when `url` is under one of the usable `prefixes`. */
export function isOfficialUrl(url: string, prefixes: readonly string[]): boolean {
  const n = normalizeDocUrl(url);
  if (n === null) return false;
  return prefixes.some((p) => docSourceProblem(p) === null && n.startsWith(normalizeDocUrl(p)!));
}
