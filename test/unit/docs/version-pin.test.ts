// A registered or queried version must be the installed version, the effective
// target (after stop_at), or a release unit between them.
import { afterEach, describe, expect, it } from 'vitest';
import { getMigrationDocs, InputError, setScope } from '../../../src/core/index.js';
import { listRunDocs } from '../../../src/store/docs.js';
import { prepare } from './prepare.js';

const page = { topic: 'cookies', url: 'https://nextjs.org/docs/app/api-reference/functions/cookies', content: 'cookies() is async.' };

let close: () => void = () => {};
afterEach(() => close());

async function register(prep: Awaited<ReturnType<typeof prepare>>, version: string) {
  return getMigrationDocs(prep.engine, { run_id: prep.runId, register: [{ library: 'next', version, ...page }] });
}

describe('version pin', () => {
  it('rejects the major before the installed one and names the versions it will accept', async () => {
    const prep = await prepare();
    close = prep.close;
    const err = await register(prep, '13').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).code).toBe('stale_version');
    expect((err as InputError).message).toContain('stale version');
    expect((err as InputError).message).toContain('next@13');
    for (const version of ['14', '14.2', '14.2.35', '15', '15.1', '15.1.0']) expect((err as InputError).message).toContain(version);
    expect(listRunDocs(prep.db(), prep.runId)).toHaveLength(0);
  });

  it('accepts the installed major, the target major and their major.minor', async () => {
    const prep = await prepare();
    close = prep.close;
    for (const version of ['14', '14.2.35', '15', '15.1.0']) {
      const out = await register(prep, version);
      expect(out.docs[0]!.version).toBe(version);
    }
  });

  it('accepts an intermediate release unit only inside the composed range', async () => {
    const prep = await prepare({ target: '16.0.0' });
    close = prep.close;
    expect((await register(prep, '15')).docs[0]!.version).toBe('15');
    const beyond = await register(prep, '17').catch((e: unknown) => e);
    expect(beyond).toBeInstanceOf(InputError);
    expect((beyond as InputError).code).toBe('stale_version');
  });

  it('rejects a release past stop_at', async () => {
    const prep = await prepare({ target: '16.0.0' });
    close = prep.close;
    await setScope(prep.engine, { run_id: prep.runId, answers: { stop_at: '15' } });
    const out = await getMigrationDocs(prep.engine, { run_id: prep.runId });
    expect(out.docs.some((d) => d.url.endsWith('/references/16.md'))).toBe(false);
    expect(out.docs.some((d) => d.url.endsWith('/references/15.md'))).toBe(true);
    const rejected = await register(prep, '16').catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(InputError);
    expect((rejected as InputError).code).toBe('stale_version');
    expect((rejected as InputError).message).toContain('next@16');
    expect((await register(prep, '15')).docs[0]!.version).toBe('15');
  });

  it('rejects a library the pack does not use', async () => {
    const prep = await prepare();
    close = prep.close;
    const err = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      register: [{ library: 'lodash', version: '4.17.21', ...page }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).code).toBe('unknown_library');
    expect((err as InputError).message).toContain('next');
    expect((err as InputError).message).toContain('react');
    expect((err as InputError).message).toContain('react-dom');
  });
});
