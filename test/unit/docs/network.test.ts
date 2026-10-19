// INV-11 (C6): Context7 is the only outbound call, and only when configured.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectPermission, repoRoot } from '../../helpers.js';
import { allImports } from '../../static.js';
import { getMigrationDocs, InputError, PermissionError } from '../../../src/core/index.js';
import { context7Fetch, context7Transport, extractDocUrl, pickLibraryId, queryContext7, serializeOutbound, type OutboundPayload } from '../../../src/docs/context7.js';
import { symbolOf } from '../../../src/docs/format.js';
import { assertAllowedUrl, CONTEXT7_URL } from '../../../src/security/network.js';
import { prepare } from './prepare.js';

const networkModules = new Set(['http', 'https', 'node:http', 'node:https', 'undici', 'node:net', 'node:tls']);

let close: () => void = () => {};
afterEach(() => close());

describe('network guard', () => {
  it('refuses a host that is not Context7', () => {
    expect(assertAllowedUrl(CONTEXT7_URL).hostname).toBe('mcp.context7.com');
    for (const url of ['https://example.com/mcp', 'https://mcp.context7.com.evil/mcp', 'http://mcp.context7.com/mcp', 'https://user:pass@mcp.context7.com/mcp']) {
      expectPermission(() => assertAllowedUrl(url), 'network');
    }
  });

  it('serialises a call with only library, version and symbol', () => {
    const raw = { library: 'next', version: '15.1.0', symbol: 'cookies', snippet: 'const x = cookies()', path: 'app/page.tsx' };
    const json = serializeOutbound(raw as OutboundPayload);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['library', 'symbol', 'version']);
    expect(json).not.toContain('page.tsx');
    expect(json).not.toContain('const x');
  });

  it('does not call fetch when Context7 is unconfigured', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      throw new Error('network was used');
    }) as typeof fetch;
    try {
      const prep = await prepare();
      close = prep.close;
      const out = await getMigrationDocs(prep.engine, { run_id: prep.runId });
      expect(out.fallback).toEqual({ reason: 'unconfigured' });
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a server-side query sends the match symbol, not a doc topic', async () => {
    const calls: OutboundPayload[] = [];
    const prep = await prepare({
      docs: {
        transport: {
          async fetch(payload) {
            calls.push(payload);
            return { ok: true, url: 'https://nextjs.org/docs/app/api-reference/functions/cookies', content: 'ok' };
          },
        },
      },
    });
    close = prep.close;
    await getMigrationDocs(prep.engine, { run_id: prep.runId });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(['library', 'symbol', 'version']);
      expect(call.symbol).not.toMatch(/\s/);
      expect(call.symbol).not.toBe('async request APIs');
    }
    expect(calls.some((c) => c.symbol === 'cookies')).toBe(true);
    expect(symbolOf({ kind: 'call', module: 'next/headers', name: 'cookies' })).toBe('cookies');
  });

  it('only src/docs/context7.ts may import a network module or call fetch', () => {
    const imported = allImports().filter((u) => networkModules.has(u.module));
    expect(imported.filter((u) => u.file !== 'src/docs/context7.ts')).toEqual([]);
    const src = path.join(repoRoot, 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.ts')) files.push(abs);
      }
    };
    walk(src);
    const fetchers = files.filter((file) => /\bfetch\s*\(|globalThis\.fetch/.test(readFileSync(file, 'utf8')));
    expect(fetchers.map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))).toEqual(['src/docs/context7.ts']);
  });

  it('refuses a snippet-like symbol and never calls the transport', async () => {
    let calls = 0;
    const prep = await prepare({
      docs: {
        transport: {
          async fetch() {
            calls += 1;
            return { ok: true, url: 'https://nextjs.org/docs/', content: 'no' };
          },
        },
      },
    });
    close = prep.close;
    const symbol = 'const SECRET = "sk-live-123"; // app/page.tsx';
    const err = await getMigrationDocs(prep.engine, { run_id: prep.runId, query: [{ library: 'next', version: '15.1.0', symbol }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as InputError).code).toBe('unknown_symbol');
    expect((err as InputError).message).toContain('cookies');
    expect((err as InputError).message).not.toContain('sk-live-123');
    expect(calls).toBe(0);
  });

  it('sends the pin version, not the raw query string', async () => {
    const calls: OutboundPayload[] = [];
    const prep = await prepare({
      docs: {
        transport: {
          async fetch(payload) {
            calls.push(payload);
            return { ok: true, url: 'https://nextjs.org/docs/', content: 'cookies() is async.' };
          },
        },
      },
    });
    close = prep.close;
    await getMigrationDocs(prep.engine, { run_id: prep.runId, query: [{ library: 'next', version: '15.1.0+deadbeef', symbol: 'cookies' }] });
    expect(calls).toEqual([{ library: 'next', version: '15.1.0', symbol: 'cookies' }]);
    expect(JSON.stringify(calls)).not.toContain('deadbeef');
  });

  it('the live fetch wrapper refuses a non-Context7 URL before fetch runs', async () => {
    let called = 0;
    const wrapped = context7Fetch(async () => {
      called += 1;
      return new Response('no');
    });
    await expect(wrapped('https://example.com/mcp')).rejects.toBeInstanceOf(PermissionError);
    await expect(wrapped('https://example.com/mcp')).rejects.toMatchObject({ code: 'network' });
    expect(called).toBe(0);
    await wrapped(CONTEXT7_URL);
    expect(called).toBe(1);
  });

  it('a hanging Context7 is tried once and the call ends within the timeout', async () => {
    const starts: number[] = [];
    const prep = await prepare({
      docs: {
        apiKey: 'test-key',
        timeoutMs: 200,
        fetch: (_input, init) => {
          starts.push(Date.now());
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        },
      },
    });
    close = prep.close;
    const started = Date.now();
    const out = await getMigrationDocs(prep.engine, {
      run_id: prep.runId,
      query: [
        { library: 'next', version: '15.1.0', symbol: 'cookies' },
        { library: 'next', version: '15.1.0', symbol: 'headers' },
      ],
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(150);
    expect(out.fallback).toEqual({ reason: 'timeout' });
    expect(out.docs.every((d) => d.fetched_by === 'knowledge')).toBe(true);
    const again = context7Transport({
      apiKey: 'test-key',
      timeoutMs: 200,
      fetch: () => {
        starts.push(Date.now());
        return new Promise(() => {});
      },
    });
    const before = starts.length;
    await again.fetch({ library: 'next', version: '15.1.0', symbol: 'cookies' });
    const afterFirst = starts.length;
    expect(afterFirst).toBeGreaterThan(before);
    const second = await again.fetch({ library: 'next', version: '15.1.0', symbol: 'headers' });
    expect(second).toEqual({ ok: false, reason: 'timeout' });
    expect(starts.length).toBe(afterFirst);
  }, 4000);

  it('reads a recorded Context7 reply without sending the repo', async () => {
    const resolved = readFileSync(path.join(repoRoot, 'test/fixtures/context7/resolve-next.md'), 'utf8');
    const queried = readFileSync(path.join(repoRoot, 'test/fixtures/context7/query-cookies.md'), 'utf8');
    expect(pickLibraryId(resolved, '15.1.0')).toBe('/vercel/next.js/v15.1.0');
    expect(extractDocUrl(queried)).toBe('https://nextjs.org/docs/app/guides/upgrading/version-15#async-request-apis-breaking-change');
    const sent: { name: string; args: Record<string, string> }[] = [];
    const result = await queryContext7(
      { library: 'next', version: '15.1.0', symbol: 'cookies', snippet: 'secret' } as OutboundPayload,
      {
        invoke: async (name, args) => {
          sent.push({ name, args });
          return { text: name === 'resolve-library-id' ? resolved : queried, isError: false };
        },
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(sent.map((s) => s.name)).toEqual(['resolve-library-id', 'query-docs']);
    for (const call of sent) {
      expect(JSON.stringify(call.args)).not.toContain('secret');
      expect(Object.values(call.args).every((v) => v === 'next' || v === 'cookies' || v.startsWith('/vercel/next.js'))).toBe(true);
    }
    expect(sent[0]!.args).toEqual({ libraryName: 'next', query: 'cookies' });
    expect(sent[1]!.args).toEqual({ libraryId: '/vercel/next.js/v15.1.0', query: 'cookies' });
  });
});
