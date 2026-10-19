// get_migration_docs: a cache, a formatter and the retrieval log (M4).
// The host agent registers what it fetched, or the engine queries Context7
// by a symbol. Either way a miss falls back to the fresh cache, the stale
// cache, then the rules and the generated references.
import { z } from 'zod';
import { BACKOFF_MS, CACHE_MAX_BYTES, cacheHit, describeDoc, docId, FRESH_FOR_MS, PROTECT_RUNS, ruleText } from '../docs/cache.js';
import { context7Transport, fetchWithBackoff, type DocsTransport, type FetchResult, type OutboundPayload } from '../docs/context7.js';
import { formatDocs, symbolOf, type FormattedDoc } from '../docs/format.js';
import { referenceUri, readPackReference } from './packReferences.js';
import { composeRun, openRunPack } from './packRun.js';
import { runTool, type Engine } from './engine.js';
import type { ComposedRule, PackComposition } from '../rules/compose.js';
import type { PackBundle } from '../rules/loader.js';
import { compareReleaseUnits, compareVersions, parseVersion, releaseUnitOf } from '../rules/versions.js';
import { GetMigrationDocsInput, type GetMigrationDocsOutput, type MigrationDoc } from '../schema/docs.js';
import type { RunVersions } from '../schema/ingest.js';
import type { ReleaseUnit, VersionScheme } from '../schema/knowledge.js';
import { InputError } from '../security/errors.js';
import { evictCache, linkRunDoc, listCache, putCache, type DocMode, type DocStatus, type FetchedBy } from '../store/docs.js';
import { getScope } from '../store/scope.js';

const AGENT_LIMIT = 'An official URL registered by the agent was not fetched by the engine, so its content is unchecked.';
const ENGINE_LIMIT = 'Docs fetched by the engine come from Context7, which is community-contributed, and were not checked against the official source.';

interface Pin {
  id: string;
  packages: readonly string[];
  scheme: VersionScheme;
  unit: ReleaseUnit;
  from: string;
  to: string;
  releases: readonly string[];
}

interface Draft {
  library: string;
  version: string;
  topic: string;
  url: string;
  content: string;
  fetchedBy: FetchedBy;
  mode: DocMode;
  fresh: boolean;
}

function minorKey(scheme: VersionScheme, raw: string): string {
  const v = parseVersion(scheme, raw);
  return `${v.release[0] ?? 0}.${v.release[1] ?? 0}`;
}

/** The installed version, the effective target, or a release unit between them, compared at major.minor. */
export function versionAllowed(candidate: string, pin: Pin): boolean {
  const v = parseVersion(pin.scheme, candidate);
  const key = minorKey(pin.scheme, candidate);
  if (key === minorKey(pin.scheme, pin.from) || key === minorKey(pin.scheme, pin.to)) return true;
  const unit = releaseUnitOf(v, pin.unit);
  if (compareVersions(v, unit) !== 0) return false;
  const ends = [pin.from, pin.to].map((raw) => releaseUnitOf(parseVersion(pin.scheme, raw), pin.unit));
  const lo = compareReleaseUnits(ends[0]!, ends[1]!, pin.unit) <= 0 ? ends[0]! : ends[1]!;
  const hi = lo === ends[0] ? ends[1]! : ends[0]!;
  return compareReleaseUnits(v, lo, pin.unit) >= 0 && compareReleaseUnits(v, hi, pin.unit) <= 0;
}

export function expectedVersions(pin: Pin): string[] {
  const set = new Set<string>([pin.from, pin.to, minorKey(pin.scheme, pin.from), minorKey(pin.scheme, pin.to)]);
  const ends = [pin.from, pin.to].map((raw) => releaseUnitOf(parseVersion(pin.scheme, raw), pin.unit));
  const lo = compareReleaseUnits(ends[0]!, ends[1]!, pin.unit) <= 0 ? ends[0]! : ends[1]!;
  const hi = lo === ends[0] ? ends[1]! : ends[0]!;
  if (pin.unit === 'major') {
    for (let n = lo.release[0]!; n <= hi.release[0]!; n++) set.add(String(n));
  }
  for (const rel of pin.releases) {
    const v = parseVersion(pin.scheme, rel);
    if (compareReleaseUnits(v, lo, pin.unit) >= 0 && compareReleaseUnits(v, hi, pin.unit) <= 0) set.add(releaseUnitOf(v, pin.unit).text);
  }
  set.add(lo.text);
  set.add(hi.text);
  return [...set].sort();
}

function pinsFor(pack: PackBundle, composed: PackComposition, versions: RunVersions): Pin[] {
  const byId = new Map(composed.libraries.map((l) => [l.library, l]));
  const pins: Pin[] = [];
  for (const ref of pack.pack.libraries) {
    const loaded = pack.libs.get(ref.id);
    if (!loaded) continue;
    const row = byId.get(ref.id);
    const installed = ref.role === 'primary' ? versions.source.version : versions.companions[ref.id];
    const from = row?.from ?? installed;
    if (!from) continue;
    pins.push({
      id: ref.id,
      packages: loaded.library.packages,
      scheme: loaded.library.version_scheme,
      unit: loaded.library.release_unit,
      from,
      to: row?.to ?? from,
      releases: loaded.releases.map((r) => r.release),
    });
  }
  return pins;
}

function findPin(pins: readonly Pin[], name: string): { pin: Pin; library: string } {
  for (const pin of pins) {
    if (pin.id === name) return { pin, library: pin.packages[0]! };
    const pkg = pin.packages.find((p) => p === name);
    if (pkg) return { pin, library: pkg };
  }
  const known = pins.flatMap((p) => p.packages).join(', ');
  throw new InputError('unknown_library', `unknown library ${name} for this pack; expected ${known}`);
}

function requireVersion(pin: Pin, library: string, version: string): void {
  if (versionAllowed(version, pin)) return;
  throw new InputError('stale_version', `stale version: ${library}@${version} is not in this run; expected ${expectedVersions(pin).join(', ')}`);
}

/** The version a query may send: the pin endpoint it matches, or the release unit, never the raw string. */
export function outboundVersion(candidate: string, pin: Pin): string {
  const v = parseVersion(pin.scheme, candidate);
  if (compareVersions(v, parseVersion(pin.scheme, pin.to)) === 0) return pin.to;
  if (compareVersions(v, parseVersion(pin.scheme, pin.from)) === 0) return pin.from;
  const key = minorKey(pin.scheme, candidate);
  if (key === minorKey(pin.scheme, pin.to)) return pin.to;
  if (key === minorKey(pin.scheme, pin.from)) return pin.from;
  return releaseUnitOf(v, pin.unit).text;
}

function symbolsFor(pin: Pin, composed: PackComposition): string[] {
  const lib = composed.libraries.find((l) => l.library === pin.id);
  return [...new Set((lib?.rules ?? []).map((rule) => symbolOf(rule.rule.match)))].sort();
}

function sideOf(version: string, pin: Pin): 'old' | 'new' | 'mid' {
  const key = minorKey(pin.scheme, version);
  if (key === minorKey(pin.scheme, pin.to)) return 'new';
  if (key === minorKey(pin.scheme, pin.from)) return 'old';
  const v = parseVersion(pin.scheme, version);
  if (compareReleaseUnits(v, parseVersion(pin.scheme, pin.to), pin.unit) === 0) return 'new';
  if (compareReleaseUnits(v, parseVersion(pin.scheme, pin.from), pin.unit) === 0) return 'old';
  return 'mid';
}

/** Server-side queries: one symbol from each rule's match, at the installed version and the effective target. */
export function serverQueries(rules: readonly ComposedRule[], pins: readonly Pin[]): OutboundPayload[] {
  const seen = new Set<string>();
  const out: OutboundPayload[] = [];
  for (const rule of rules) {
    const pin = pins.find((p) => p.id === rule.library);
    if (!pin) continue;
    const symbol = symbolOf(rule.rule.match);
    for (const version of new Set([pin.from, pin.to])) {
      const key = `${pin.packages[0]}@${version}|${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ library: pin.packages[0]!, version, symbol });
    }
  }
  return out;
}

function knowledgeDrafts(pack: PackBundle, composed: PackComposition, pins: readonly Pin[]): Draft[] {
  const drafts: Draft[] = [];
  const primary = pins.find((p) => p.id === pack.pack.libraries.find((l) => l.role === 'primary')!.id);
  for (const lib of composed.libraries) {
    const pin = pins.find((p) => p.id === lib.library);
    if (!pin) continue;
    for (const rule of lib.rules) {
      const version = rule.in_range[rule.in_range.length - 1]!.version;
      drafts.push({
        library: pin.packages[0]!,
        version,
        topic: symbolOf(rule.rule.match),
        url: rule.rule.source,
        content: ruleText(rule.rule),
        fetchedBy: 'knowledge',
        mode: 'fallback',
        fresh: false,
      });
    }
  }
  if (!primary) return drafts;
  const addRef = (file: string, library: string, version: string): void => {
    const content = readPackReference(referenceUri(pack.pack.name, file));
    if (content === null) return;
    drafts.push({
      library,
      version,
      topic: file,
      url: `pack://${pack.pack.name}@${pack.pack.version}/references/${file}`,
      content,
      fetchedBy: 'knowledge',
      mode: 'fallback',
      fresh: false,
    });
  };
  if (primary.unit === 'major') {
    const ends = [primary.from, primary.to].map((raw) => releaseUnitOf(parseVersion(primary.scheme, raw), 'major').release[0]!);
    for (let n = Math.min(...ends); n <= Math.max(...ends); n++) addRef(`${n}.md`, primary.packages[0]!, String(n));
  }
  for (const ref of pack.pack.libraries.filter((l) => l.role === 'companion')) {
    const pin = pins.find((p) => p.id === ref.id);
    if (!pin) continue;
    addRef(`${ref.id.split('/')[1]}-changes.md`, pin.packages[0]!, releaseUnitOf(parseVersion(pin.scheme, pin.to), pin.unit).text);
  }
  addRef('codemods.md', primary.packages[0]!, releaseUnitOf(parseVersion(primary.scheme, primary.to), primary.unit).text);
  return drafts;
}

function transportFor(engine: Engine): DocsTransport | null {
  const docs = engine.options.docs;
  if (docs?.transport) return docs.transport;
  if (docs?.apiKey === null) return null;
  const key = (docs?.apiKey ?? process.env.CONTEXT7_API_KEY)?.trim();
  if (!key) return null;
  return context7Transport({ apiKey: key, fetch: docs?.fetch, timeoutMs: docs?.timeoutMs });
}

export async function getMigrationDocs(engine: Engine, raw: unknown): Promise<GetMigrationDocsOutput> {
  const parsed = GetMigrationDocsInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const input = parsed.data;
  const opened = openRunPack(engine, input.run_id);
  return runTool(engine, opened.session, 'get_migration_docs', input, async (call) => {
    call.attachRun(opened.run.id);
    const stop = getScope(opened.session.db, opened.run.id)?.answers.stop_at;
    const composed = composeRun(opened.pack, opened.versions, typeof stop === 'string' ? { stopAt: stop } : {});
    const pins = pinsFor(opened.pack, composed, opened.versions);
    const prefixes = [...opened.pack.libs.values()].flatMap((l) => l.library.doc_sources);
    const knowledge = knowledgeDrafts(opened.pack, composed, pins);
    const freshFor = engine.options.docs?.freshForMs ?? FRESH_FOR_MS;
    const drafts: Draft[] = [];

    const pushKnowledge = (matches: readonly Draft[]): void => {
      if (matches.length) drafts.push(...matches);
    };

    const fromCacheOrKnowledge = (library: string, version: string, topic: string): void => {
      const hit = cacheHit(listCache(opened.session.db), library, version, topic, engine.now(), freshFor);
      if (hit) {
        drafts.push({
          library: hit.row.library,
          version: hit.row.version,
          topic: hit.row.topic,
          url: hit.row.url,
          content: hit.row.content,
          fetchedBy: hit.row.source,
          mode: 'cache',
          fresh: hit.status === 'fresh',
        });
        return;
      }
      const forTopic = knowledge.filter((d) => d.library === library && d.topic === topic);
      pushKnowledge(forTopic.length ? forTopic : knowledge.filter((d) => d.library === library));
    };

    for (const item of input.register ?? []) {
      const { pin, library } = findPin(pins, item.library);
      requireVersion(pin, library, item.version);
      drafts.push({ library, version: item.version, topic: item.topic, url: item.url, content: item.content, fetchedBy: 'agent', mode: 'register', fresh: true });
    }

    const transport = transportFor(engine);
    const explicit = input.query ?? [];
    const queries = explicit.length ? explicit.map((q) => ({ library: q.library, version: q.version, symbol: q.symbol })) : !input.register && transport ? serverQueries(composed.libraries.flatMap((l) => l.rules), pins) : [];
    let fallback: GetMigrationDocsOutput['fallback'] = null;
    const bare = !input.register && explicit.length === 0 && !transport;

    if (explicit.length && !transport) fallback = { reason: 'unconfigured' };
    if (bare) fallback = { reason: 'unconfigured' };

    const sleep = engine.options.docs?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    let transportDown = false;
    for (const query of queries) {
      const { pin, library } = findPin(pins, query.library);
      requireVersion(pin, library, query.version);
      const allowed = symbolsFor(pin, composed);
      if (!allowed.includes(query.symbol)) {
        throw new InputError('unknown_symbol', `unknown symbol for ${library}; expected ${allowed.join(', ')}`);
      }
      const version = outboundVersion(query.version, pin);
      let fetched: FetchResult | undefined;
      if (transport && !transportDown) {
        try {
          fetched = await fetchWithBackoff(transport, { library, version, symbol: query.symbol }, sleep, BACKOFF_MS);
        } catch {
          fetched = { ok: false, reason: 'offline' };
        }
        if (!fetched.ok) transportDown = true;
      }
      if (fetched?.ok) {
        drafts.push({ library, version, topic: query.symbol, url: fetched.url, content: fetched.content, fetchedBy: 'engine', mode: 'query', fresh: true });
        continue;
      }
      if (fetched && !fetched.ok) fallback = { reason: fetched.reason };
      fromCacheOrKnowledge(library, version, query.symbol);
    }

    if (bare) {
      const cached = listCache(opened.session.db).filter((row) => row.source !== 'knowledge' && pins.some((pin) => pin.packages.includes(row.library) && versionAllowed(row.version, pin)));
      const fresh = cached.filter((row) => cacheHit([row], row.library, row.version, row.topic, engine.now(), freshFor)?.status === 'fresh');
      const chosen = fresh.length ? fresh : cached;
      if (chosen.length) {
        for (const row of chosen) {
          drafts.push({
            library: row.library,
            version: row.version,
            topic: row.topic,
            url: row.url,
            content: row.content,
            fetchedBy: row.source,
            mode: 'cache',
            fresh: fresh.length > 0,
          });
        }
      } else {
        drafts.push(...knowledge);
      }
    }

    const seen = new Set<string>();
    const stored: (Draft & { doc_id: string; official: boolean; status: DocStatus })[] = [];
    for (const draft of drafts) {
      const doc_id = docId(draft.library, draft.version, draft.url, draft.content);
      if (seen.has(doc_id)) continue;
      seen.add(doc_id);
      const described = describeDoc({ fetchedBy: draft.fetchedBy, url: draft.url, prefixes, fresh: draft.fresh });
      putCache(opened.session.db, {
        doc_id,
        library: draft.library,
        version: draft.version,
        topic: draft.topic,
        url: draft.url,
        content: draft.content,
        fetched_at: engine.now().toISOString(),
        source: draft.fetchedBy,
      });
      linkRunDoc(opened.session.db, { run_id: opened.run.id, doc_id, mode: draft.mode, status: described.status, fetched_by: draft.fetchedBy, official: described.official });
      stored.push({ ...draft, doc_id, ...described });
    }
    evictCache(opened.session.db, engine.options.docs?.cacheMaxBytes ?? CACHE_MAX_BYTES, engine.options.docs?.protectRuns ?? PROTECT_RUNS);

    if (fallback) call.event('docs.fallback', fallback);
    for (const doc of stored) {
      call.event('docs.retrieved', { doc_id: doc.doc_id, url: doc.url, library: doc.library, version: doc.version, fetched_by: doc.fetchedBy, official: doc.official, status: doc.status });
    }

    const pinOf = (library: string): Pin => pins.find((p) => p.packages.includes(library) || p.id === library) ?? pins[0]!;
    const oldVersions = new Set<string>();
    const newVersions = new Set<string>();
    for (const doc of stored) {
      const side = sideOf(doc.version, pinOf(doc.library));
      if (side === 'old') oldVersions.add(doc.version);
      if (side === 'new') newVersions.add(doc.version);
    }
    const views: FormattedDoc[] = stored.map((doc) => ({
      topic: doc.topic,
      library: doc.library,
      version: doc.version,
      content: doc.content,
      status: doc.status,
      doc_id: doc.doc_id,
      url: doc.url,
      fetched_by: doc.fetchedBy,
      official: doc.official,
    }));
    const formatted = formatDocs(views, oldVersions, newVersions);
    const docs: MigrationDoc[] = views.map((doc) => ({
      doc_id: doc.doc_id,
      url: doc.url,
      library: doc.library,
      version: doc.version,
      topic: doc.topic,
      status: doc.status,
      fetched_by: doc.fetched_by as FetchedBy,
      official: doc.official,
      text: formatDocs([doc], oldVersions, newVersions),
    }));
    const limits: string[] = [];
    if (stored.some((d) => d.fetchedBy === 'agent')) limits.push(AGENT_LIMIT);
    if (stored.some((d) => d.fetchedBy === 'engine')) limits.push(ENGINE_LIMIT);
    return { docs, formatted, fallback, limits };
  });
}
