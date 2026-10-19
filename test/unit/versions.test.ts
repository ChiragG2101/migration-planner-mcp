// INV-38: version ordering for semver and PEP 440, release-unit comparison,
// and the pre-release refusal in each scheme.
import { describe, expect, it } from 'vitest';
import {
  PRE_RELEASE_MESSAGE,
  compareReleaseUnits,
  compareVersions,
  lowestSatisfying,
  parseVersion,
  satisfies,
  validRange,
} from '../../src/rules/versions.js';
import type { VersionScheme } from '../../src/schema/knowledge.js';

const cmp = (s: VersionScheme, a: string, b: string): number => compareVersions(parseVersion(s, a), parseVersion(s, b));

describe('version ordering', () => {
  it.each([
    ['semver', '14.2.35', '15.0.0', -1],
    ['semver', '15', '15.0.0', 0],
    ['semver', '13.2', '13.10', -1],
    ['semver', '15.3.2', '15.3.10', -1],
    ['semver', '16.0.0', '15.99.99', 1],
    ['semver', 'v15.1.0', '15.1.0', 0],
    ['semver', '15.1.0+build.7', '15.1.0', 0],
    ['pep440', '4.2', '4.10', -1],
    ['pep440', '4.2', '4.2.0', 0],
    ['pep440', '5.2.7', '5.2.10', -1],
    ['pep440', '4.2.30', '5.0', -1],
    ['pep440', '3.2.25', '3.2.25.post1', -1],
    ['pep440', '1!1.0', '2.0', 1],
    ['pep440', '==4.2.30', '4.2.30', 0],
  ] as const)('%s: %s vs %s is %d', (s, a, b, want) => {
    expect(cmp(s, a, b)).toBe(want);
  });

  it.each([
    ['semver', '16.0.0-canary.1'],
    ['semver', '19.0.0-rc.1'],
    ['semver', '15.0.0-beta.0'],
    ['pep440', '5.2a1'],
    ['pep440', '5.2b2'],
    ['pep440', '5.2rc1'],
    ['pep440', '5.2.dev3'],
    ['pep440', '6.0.0-alpha.1'],
  ] as const)('%s refuses the pre-release %s', (s, v) => {
    expect(() => parseVersion(s, v)).toThrow(PRE_RELEASE_MESSAGE);
  });

  it('rejects malformed versions', () => {
    expect(() => parseVersion('semver', 'latest')).toThrow(/not a semver/);
    expect(() => parseVersion('pep440', '4.x')).toThrow(/not a PEP 440/);
  });
});

describe('release units', () => {
  it('compares by major for Next.js and by X.Y for Django', () => {
    expect(compareReleaseUnits(parseVersion('semver', '15.3.2'), parseVersion('semver', '15'), 'major')).toBe(0);
    expect(compareReleaseUnits(parseVersion('semver', '16.0.0'), parseVersion('semver', '15'), 'major')).toBe(1);
    expect(compareReleaseUnits(parseVersion('pep440', '5.2.7'), parseVersion('pep440', '5.2'), 'minor')).toBe(0);
    expect(compareReleaseUnits(parseVersion('pep440', '6.0'), parseVersion('pep440', '5.2'), 'minor')).toBe(1);
    expect(compareReleaseUnits(parseVersion('pep440', '4.10.1'), parseVersion('pep440', '4.2'), 'minor')).toBe(1);
  });
});

describe('ranges', () => {
  it('checks semver and PEP 440 ranges', () => {
    expect(satisfies(parseVersion('semver', '19.0.0'), '>=19')).toBe(true);
    expect(satisfies(parseVersion('semver', '18.3.1'), '>=19')).toBe(false);
    expect(satisfies(parseVersion('pep440', '4.2.30'), '>=4.2,<5.0')).toBe(true);
    expect(satisfies(parseVersion('pep440', '5.0'), '>=4.2,<5.0')).toBe(false);
    expect(satisfies(parseVersion('pep440', '4.2.7'), '~=4.2')).toBe(true);
    expect(satisfies(parseVersion('pep440', '5.1'), '~=4.2')).toBe(false);
    expect(satisfies(parseVersion('pep440', '4.2.7'), '==4.2.*')).toBe(true);
    expect(satisfies(parseVersion('pep440', '4.3'), '==4.2.*')).toBe(false);
    expect(satisfies(parseVersion('pep440', '4.1'), '!=4.1')).toBe(false);
  });

  it('validates ranges per scheme', () => {
    expect(validRange('semver', '>=19 <20')).toBe(true);
    expect(validRange('semver', '*')).toBe(true);
    expect(validRange('semver', 'not a range')).toBe(false);
    expect(validRange('pep440', '>=4.2,<5.0')).toBe(true);
    expect(validRange('pep440', '>=4.2 && <5')).toBe(false);
  });

  it('finds the lowest version that satisfies every range; the stricter one wins', () => {
    expect(lowestSatisfying('semver', ['>=19'])?.text).toBe('19.0.0');
    expect(lowestSatisfying('semver', ['>=19', '>=19.2'])?.text).toBe('19.2.0');
    expect(lowestSatisfying('semver', ['^18.2.0 || ^19.0.0', '>=19'])?.text).toBe('19.0.0');
    expect(lowestSatisfying('semver', ['^18 || >=20', '>=19'])?.text).toBe('20.0.0');
    expect(lowestSatisfying('semver', ['>=19 <19.2', '>=19.2'])).toBeNull();
    expect(lowestSatisfying('pep440', ['>=4.2', '>=5.0,<6'])?.text).toBe('5.0');
    expect(lowestSatisfying('pep440', ['<4', '>=5'])).toBeNull();
  });
});
