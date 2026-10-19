// The two version schemes v0.1 needs: `semver` (npm) and `pep440` (PyPI).
// Knowledge writes releases as plain versions (`15`, `13.2`, `4.2`), users
// give full ones (`15.3.2`, `5.2.7`); both parse here. Pre-releases are
// refused in both schemes (INV-38). Comparison by release unit is what the
// pack's `supported` range uses, so `15.3.2` counts as `15` and `5.2.7` as
// `5.2` (D13).
import semver from 'semver';
import type { ReleaseUnit, VersionScheme } from '../schema/knowledge.js';
import { InputError, NotBuiltError } from '../security/errors.js';

export const PRE_RELEASE_MESSAGE = 'pre-release versions not supported in v0.1';

export interface Version {
  readonly scheme: VersionScheme;
  readonly text: string;
  readonly epoch: number;
  /** The release numbers, trailing zeros kept as written. */
  readonly release: readonly number[];
  /** PEP 440 post-release number; -1 when absent. */
  readonly post: number;
}

const semverRe = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// PEP 440 public versions, case-insensitive, with the spec's alternative spellings.
const pep440Re =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d*)))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

/** Parses a version, refusing pre-releases (canary, rc, a, b, dev) with one message. */
export function parseVersion(scheme: VersionScheme, raw: string): Version {
  const text = raw.trim().replace(/^==/, '');
  if (scheme === 'semver') {
    const m = semverRe.exec(text);
    if (!m) throw new InputError('bad_version', `"${raw}" is not a semver version`);
    if (m[4] !== undefined) throw new NotBuiltError(PRE_RELEASE_MESSAGE);
    const release = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number);
    return { scheme, text, epoch: 0, release, post: -1 };
  }
  const m = pep440Re.exec(text);
  if (!m) throw new InputError('bad_version', `"${raw}" is not a PEP 440 version`);
  if (m[3] !== undefined || m[8] !== undefined) throw new NotBuiltError(PRE_RELEASE_MESSAGE);
  const post = m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? Number(m[7] || 0) : -1;
  return { scheme, text, epoch: Number(m[1] ?? 0), release: m[2]!.split('.').map(Number), post };
}

/** -1, 0 or 1. Missing release numbers count as zero, so `4.2` equals `4.2.0`. */
export function compareVersions(a: Version, b: Version): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  const n = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < n; i++) {
    const x = a.release[i] ?? 0;
    const y = b.release[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.post !== b.post) return a.post < b.post ? -1 : 1;
  return 0;
}

/** The release unit a version belongs to: `15` for `15.3.2` (major), `5.2` for `5.2.7` (minor). */
export function releaseUnitOf(v: Version, unit: ReleaseUnit): Version {
  const keep = unit === 'major' ? 1 : 2;
  const release = Array.from({ length: keep }, (_, i) => v.release[i] ?? 0);
  return { scheme: v.scheme, text: release.join('.'), epoch: v.epoch, release, post: -1 };
}

/** Compares the release units of two versions. */
export function compareReleaseUnits(a: Version, b: Version, unit: ReleaseUnit): number {
  return compareVersions(releaseUnitOf(a, unit), releaseUnitOf(b, unit));
}

const asSemver = (v: Version): string => [0, 1, 2].map((i) => v.release[i] ?? 0).join('.');

// PEP 440 specifiers: `>=4.2,<5.0`, `~=4.2`, `==4.2.*`, `!=4.1`.
const specRe = /^(~=|===|==|!=|<=|>=|<|>)\s*(.+)$/;

function pepSatisfies(v: Version, spec: string): boolean {
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = specRe.exec(part);
    if (!m) throw new InputError('bad_range', `"${spec}" is not a PEP 440 specifier`);
    const [, op, rawTarget] = m as unknown as [string, string, string];
    if ((op === '==' || op === '!=') && rawTarget.endsWith('.*')) {
      const prefix = parseVersion('pep440', rawTarget.slice(0, -2)).release;
      const hit = prefix.every((n, i) => (v.release[i] ?? 0) === n);
      if (op === '==' ? !hit : hit) return false;
      continue;
    }
    const t = parseVersion('pep440', rawTarget);
    const c = compareVersions(v, t);
    const pass =
      op === '>='
        ? c >= 0
        : op === '<='
          ? c <= 0
          : op === '>'
            ? c > 0
            : op === '<'
              ? c < 0
              : op === '!='
                ? c !== 0
                : op === '~='
                  ? c >= 0 && t.release.length >= 2 && t.release.slice(0, -1).every((n, i) => (v.release[i] ?? 0) === n)
                  : c === 0;
    if (!pass) return false;
  }
  return true;
}

/** True when the range is well formed in the scheme. `*` is any version. */
export function validRange(scheme: VersionScheme, range: string): boolean {
  if (range.trim() === '*') return true;
  if (scheme === 'semver') return semver.validRange(range) !== null && !/-/.test(range.replace(/\s-\s/g, ' '));
  try {
    pepSatisfies({ scheme, text: '0', epoch: 0, release: [0], post: -1 }, range);
    return true;
  } catch {
    return false;
  }
}

export function satisfies(v: Version, range: string): boolean {
  if (range.trim() === '*') return true;
  if (v.scheme === 'semver') return semver.satisfies(asSemver(v), range);
  return pepSatisfies(v, range);
}

/**
 * The lowest version that satisfies every range, or null when none does. Used
 * for a companion's target: the stricter requirement wins (D13).
 */
export function lowestSatisfying(scheme: VersionScheme, ranges: readonly string[]): Version | null {
  const real = ranges.filter((r) => r.trim() !== '*');
  if (scheme === 'semver') {
    // The answer is the lower bound of some `||` alternative of some range, so try each one.
    const candidates = ['0.0.0'];
    for (const r of real) {
      for (const set of new semver.Range(r).set) {
        const min = semver.minVersion(set.map((c) => c.value).join(' ') || '*');
        if (min && min.prerelease.length === 0) candidates.push(min.version);
      }
    }
    const ok = candidates
      .map((c) => parseVersion('semver', c))
      .filter((c) => real.every((r) => semver.satisfies(asSemver(c), r)))
      .sort(compareVersions);
    return ok[0] ?? null;
  }
  const lows: Version[] = [{ scheme, text: '0', epoch: 0, release: [0], post: -1 }];
  for (const r of real) {
    for (const part of r.split(',').map((s) => s.trim())) {
      const m = specRe.exec(part);
      if (m && (m[1] === '>=' || m[1] === '~=' || m[1] === '==' || m[1] === '===') && !m[2]!.endsWith('.*')) lows.push(parseVersion('pep440', m[2]!));
      if (m && m[1] === '==' && m[2]!.endsWith('.*')) lows.push(parseVersion('pep440', m[2]!.slice(0, -2)));
    }
  }
  const ok = lows.filter((c) => real.every((r) => pepSatisfies(c, r))).sort(compareVersions);
  return ok[0] ?? null;
}

export const versionText = (v: Version): string => v.text;
