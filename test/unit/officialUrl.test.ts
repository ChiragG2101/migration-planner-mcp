// INV-39 (D14): the shared official-URL check. A plain prefix match would
// accept a `..` climb, a look-alike host and a sibling repo; this one doesn't.
import { describe, expect, it } from 'vitest';
import { docSourceProblem, isOfficialUrl } from '../../src/docs/officialUrl.js';

const next = ['https://nextjs.org/docs/', 'https://github.com/vercel/next.js/'];

describe('official URL check', () => {
  it('accepts a URL under a prefix, and one differing only by host case or a default port', () => {
    expect(isOfficialUrl('https://nextjs.org/docs/app/guides/upgrading/version-15#async', next)).toBe(true);
    expect(isOfficialUrl('https://NextJS.org/docs/app', next)).toBe(true);
    expect(isOfficialUrl('HTTPS://nextjs.org:443/docs/app', next)).toBe(true);
    expect(isOfficialUrl('https://github.com/vercel/next.js/blob/canary/docs/x.mdx', next)).toBe(true);
  });

  it('rejects a .. path that climbs out of its prefix, also percent-encoded', () => {
    expect(isOfficialUrl('https://nextjs.org/docs/../blog/next-15', next)).toBe(false);
    expect(isOfficialUrl('https://nextjs.org/docs/%2e%2e/blog/next-15', next)).toBe(false);
    expect(isOfficialUrl('https://github.com/vercel/next.js/../next.js-fork/x', next)).toBe(false);
  });

  it('rejects a look-alike host and a sibling repo', () => {
    expect(isOfficialUrl('https://nextjs.org.evil.example/docs/app', next)).toBe(false);
    expect(isOfficialUrl('https://evil.example/https://nextjs.org/docs/', next)).toBe(false);
    expect(isOfficialUrl('https://github.com/vercel/next.js-fork/blob/x', next)).toBe(false);
  });

  it('rejects http://, credentials and non-URLs', () => {
    expect(isOfficialUrl('http://nextjs.org/docs/app', next)).toBe(false);
    expect(isOfficialUrl('https://user:pw@nextjs.org/docs/app', next)).toBe(false);
    expect(isOfficialUrl('https://user@nextjs.org/docs/app', next)).toBe(false);
    expect(isOfficialUrl('nextjs.org/docs/app', next)).toBe(false);
  });

  it('never matches through a prefix that is itself unusable', () => {
    expect(isOfficialUrl('https://github.com/vercel/next.js-fork/x', ['https://github.com/vercel/next.js'])).toBe(false);
    expect(isOfficialUrl('http://nextjs.org/docs/x', ['http://nextjs.org/docs/'])).toBe(false);
  });

  it('names what is wrong with a bad doc_sources prefix', () => {
    expect(docSourceProblem('https://nextjs.org/docs/')).toBeNull();
    expect(docSourceProblem('https://github.com/vercel/next.js')).toMatch(/end in \//);
    expect(docSourceProblem('http://nextjs.org/docs/')).toMatch(/https/);
    expect(docSourceProblem('https://u:p@nextjs.org/docs/')).toMatch(/credentials/);
    expect(docSourceProblem('https://nextjs.org/docs/?x=/')).toMatch(/query/);
  });
});
