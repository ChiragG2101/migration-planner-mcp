// The Context7 client (M4). The engine's outbound record is {library, version,
// symbol} and nothing else (C6). Tool names were re-checked on 2026-10-20
// against the Context7 MCP server: resolve-library-id, then query-docs.
// query-docs takes libraryId and query; the query we send is the symbol.
import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assertAllowedUrl, CONTEXT7_URL } from '../security/network.js';
import { CONTEXT7_TIMEOUT_MS } from './cache.js';

/** The only keys an outbound Context7 call may carry. */
export const OUTBOUND_KEYS = ['library', 'version', 'symbol'] as const;

export interface OutboundPayload {
  library: string;
  version: string;
  symbol: string;
}

export type TransportFailure = 'timeout' | '429' | 'offline';

export type FetchResult = { ok: true; url: string; content: string } | { ok: false; reason: TransportFailure };

export interface DocsTransport {
  fetch(payload: OutboundPayload): Promise<FetchResult>;
}

/** Serialises a call with exactly the allowed keys, dropping anything else that was attached. */
export function serializeOutbound(input: OutboundPayload): string {
  const body: OutboundPayload = { library: input.library, version: input.version, symbol: input.symbol };
  return JSON.stringify(body);
}

export function parseOutbound(json: string): OutboundPayload {
  const parsed = JSON.parse(json) as OutboundPayload;
  return { library: parsed.library, version: parsed.version, symbol: parsed.symbol };
}

/** Runs the transport once, and once more after a 429. Any other failure is returned as it is. */
export async function fetchWithBackoff(transport: DocsTransport, payload: OutboundPayload, sleep: (ms: number) => Promise<void>, backoffMs: number): Promise<FetchResult> {
  const sent = parseOutbound(serializeOutbound(payload));
  const first = await transport.fetch(sent);
  if (first.ok || first.reason !== '429') return first;
  await sleep(backoffMs);
  return transport.fetch(sent);
}

const LIBRARY_ID = /\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*/g;

/** Picks a Context7 library id from a resolve-library-id reply. A versioned id is used only when the reply contains it. */
export function pickLibraryId(text: string, version: string): string | null {
  const ids = [...text.matchAll(LIBRARY_ID)].map((m) => m[0]);
  const versioned = ids.find((id) => id.endsWith(`/${version}`) || id.endsWith(`/v${version}`));
  if (versioned) return versioned;
  const base = ids.find((id) => id.split('/').length === 3);
  if (!base) return ids[0] ?? null;
  if (text.includes(`${base}/v${version}`)) return `${base}/v${version}`;
  if (text.includes(`${base}/${version}`)) return `${base}/${version}`;
  return base;
}

/** The first https URL in a snippet, or the Context7 endpoint when the snippet names none. */
export function extractDocUrl(content: string): string {
  const match = /https:\/\/[^\s)>\]]+/.exec(content);
  if (!match) return CONTEXT7_URL;
  return match[0].replace(/[.,;]+$/, '');
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function classifyTransportError(err: unknown): TransportFailure {
  if (err instanceof SdkHttpError && err.status === 429) return '429';
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  if (/429|rate limit|too many requests/i.test(message)) return '429';
  if (/timeout|timed out|aborted/i.test(message)) return 'timeout';
  return 'offline';
}

export interface Context7Deps {
  /** Tool call. Tests pass a fake; the default talks to the allowlisted host. */
  invoke: (name: 'resolve-library-id' | 'query-docs', args: Record<string, string>) => Promise<{ text: string; isError: boolean }>;
}

/** One logical Context7 lookup. Arguments are derived only from the three payload fields. */
export async function queryContext7(payload: OutboundPayload, deps: Context7Deps): Promise<FetchResult> {
  const sent = parseOutbound(serializeOutbound(payload));
  try {
    const resolved = await deps.invoke('resolve-library-id', { libraryName: sent.library, query: sent.symbol });
    if (resolved.isError) return { ok: false, reason: /429|rate limit/i.test(resolved.text) ? '429' : 'offline' };
    const libraryId = pickLibraryId(resolved.text, sent.version);
    if (!libraryId) return { ok: false, reason: 'offline' };
    const queried = await deps.invoke('query-docs', { libraryId, query: sent.symbol });
    if (queried.isError) return { ok: false, reason: /429|rate limit/i.test(queried.text) ? '429' : 'offline' };
    const content = queried.text.trim();
    if (!content) return { ok: false, reason: 'offline' };
    return { ok: true, url: extractDocUrl(content), content };
  } catch (err) {
    return { ok: false, reason: classifyTransportError(err) };
  }
}

export interface LiveClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The fetch the live client uses. A URL outside the allowlist throws before the underlying fetch runs. */
export function context7Fetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assertAllowedUrl(raw);
    return base(input, init);
  };
}

/** A transport that calls the hosted Context7 MCP server. The URL is the allowlisted one; a fetch to anything else throws. */
export function context7Transport(options: LiveClientOptions): DocsTransport {
  const endpoint = assertAllowedUrl(CONTEXT7_URL);
  const timeout = options.timeoutMs ?? CONTEXT7_TIMEOUT_MS;
  const fetch = context7Fetch(options.fetch ?? globalThis.fetch.bind(globalThis));
  let client: Client | undefined;
  let down: TransportFailure | undefined;
  const connect = async (): Promise<Client> => {
    if (client) return client;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => options.apiKey },
      fetch,
    });
    const next = new Client({ name: 'migration-planner-mcp', version: '0.0.0' });
    try {
      await next.connect(transport, { timeout });
    } catch (err) {
      down = classifyTransportError(err);
      throw err;
    }
    client = next;
    return next;
  };
  return {
    async fetch(payload) {
      if (down) return { ok: false, reason: down };
      const result = await queryContext7(payload, {
        invoke: async (name, args) => {
          const current = await connect();
          const called = await current.callTool({ name, arguments: args }, { timeout });
          return { text: textOf(called.content), isError: called.isError === true };
        },
      });
      if (!result.ok && result.reason !== '429') down = result.reason;
      return result;
    },
  };
}
