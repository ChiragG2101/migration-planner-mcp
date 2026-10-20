// Golden-case tool vetting tests (M7 Tests: golden-case tools, offline). The
// finder and re-checker share these pure checks; here they run on recorded
// GitHub-shaped fixtures with no network.
import { describe, expect, it } from 'vitest';
import { isBotAuthor, licenseAllowed, parentageHolds, versionFromLockfile, versionsMatch, vetCandidate, type VetInput } from '../../../eval/caseVet.js';

const good: VetInput = {
  candidate: { repo_url: 'https://github.com/acme/web', base_commit: 'base', merge_commit: 'merge', pr_url: 'https://github.com/acme/web/pull/1', source: '14.2.35', target: '15.5.0', license: 'MIT' },
  author: { login: 'alice', type: 'User' },
  mergeParents: ['base', 'other'],
  baseLockfile: { next: '14.2.35' },
  mergeLockfile: { next: '15.5.0' },
  library: 'next',
  testInfo: { hasTestScript: true, hasCiWorkflow: false },
  fetchable: { base: true, merge: true },
};

describe('individual checks', () => {
  it('licence allowlist', () => {
    expect(licenseAllowed('MIT')).toBe(true);
    expect(licenseAllowed(null)).toBe(false);
    expect(licenseAllowed('Commercial')).toBe(false);
  });
  it('bot author detection', () => {
    expect(isBotAuthor({ login: 'dependabot[bot]' })).toBe(true);
    expect(isBotAuthor({ login: 'renovate' })).toBe(true);
    expect(isBotAuthor({ login: 'alice', type: 'User' })).toBe(false);
  });
  it('parentage: base must be the first parent', () => {
    expect(parentageHolds('base', ['base', 'other'])).toBe(true);
    expect(parentageHolds('base', ['other', 'base'])).toBe(false);
  });
  it('version read from the lockfile, never the title', () => {
    expect(versionFromLockfile({ next: '14.2.35' }, 'next')).toBe('14.2.35');
    expect(versionFromLockfile(null, 'next')).toBeNull();
  });
  it('versions match tolerates a longer lockfile pin', () => {
    expect(versionsMatch({ source: '14.2', target: '15' }, { baseVersion: '14.2.35', mergeVersion: '15.5.0' }).ok).toBe(true);
    expect(versionsMatch({ source: '14', target: '15' }, { baseVersion: null, mergeVersion: '15.5.0' }).ok).toBe(false);
  });
});

describe('vetCandidate', () => {
  it('passes a clean candidate', () => {
    expect(vetCandidate(good).pass).toBe(true);
  });
  it('rejects a bot PR', () => {
    const r = vetCandidate({ ...good, author: { login: 'dependabot[bot]', type: 'Bot' } });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'not a bot PR')!.ok).toBe(false);
  });
  it('rejects an unlicensed repo', () => {
    const r = vetCandidate({ ...good, candidate: { ...good.candidate, license: null } });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'open licence')!.ok).toBe(false);
  });
  it('rejects a lockfile that does not show the version change', () => {
    const r = vetCandidate({ ...good, mergeLockfile: { next: '14.2.35' } });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'lockfile shows the version change')!.ok).toBe(false);
  });
  it('rejects a base that is not the merge first parent', () => {
    const r = vetCandidate({ ...good, mergeParents: ['other', 'base'] });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'base is merge first parent')!.ok).toBe(false);
  });
  it('rejects a repo with no test or CI at base', () => {
    const r = vetCandidate({ ...good, testInfo: { hasTestScript: false, hasCiWorkflow: false } });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'test or CI at base')!.ok).toBe(false);
  });
});
