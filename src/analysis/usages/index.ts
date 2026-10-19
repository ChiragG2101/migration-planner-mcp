// The usage adapters (one line per pack; M10 adds Django here) and the run
// that builds a repo's usage index: parse every walked code file once (or
// take its facts from the sha256 cache), resolve the import graph, let the
// adapter detect usages, then add IDs, snippet hashes and context. Nothing is
// dropped silently: unparsed files, unresolved dynamic imports, size-limit
// skips and excluded build output all go into the summary.
import { createHash } from 'node:crypto';
import type { FileFacts, LanguageAdapter, ResolveContext } from '../../lang/adapter.js';
import { type FileEntry, Graph } from '../../lang/graph.js';
import { adapterFor } from '../../lang/index.js';
import { scanLines } from '../../lang/text.js';
import type { Usage, UsageSummary, UnparsedFile, UnresolvedDynamic } from '../../schema/usage.js';
import { resolveInside } from '../../security/pathBoundary.js';
import { readText } from '../../security/safeRead.js';
import type { ImportRow, SymbolRow } from '../../store/usages.js';
import type { RepoFacts } from '../scanner.js';
import { sliceLines, snippetHash } from '../snippet.js';
import type { UsageAdapter, UsageContext, UsageDraft } from './adapter.js';
import { nextjsAdapter } from './nextjs.js';

export const usageAdapters: readonly UsageAdapter[] = [nextjsAdapter];

/**
 * For a library no pack covers yet (Django until M10): the import graph and
 * symbols are still built and stored, and no usages are reported.
 */
export const graphOnlyAdapter: UsageAdapter = {
  id: 'none',
  version: 1,
  libraries: [],
  languages: [],
  match_kinds: [],
  usage_kinds: [],
  excludes: [],
  detect: () => ({ usages: [], peer_data_unavailable: [] }),
};

/** The adapter for a run's source library. M3 replaces this with the pack's `usage_adapter`. */
export function usageAdapterFor(library: string): UsageAdapter {
  return usageAdapters.find((a) => a.libraries.includes(library)) ?? graphOnlyAdapter;
}

export interface FactsCache {
  get(extractor: string, sha256: string): string | undefined;
  put(extractor: string, sha256: string, json: string): void;
}

export interface BuildInput {
  root: string;
  repoId: string;
  repo: RepoFacts;
  adapter: UsageAdapter;
  targets: Readonly<Record<string, string>>;
  cache: FactsCache;
}

export interface BuildResult {
  usages: Usage[];
  imports: ImportRow[];
  symbols: SymbolRow[];
  summary: Omit<UsageSummary, 'duration_ms'>;
}

/** Lines of context on each side of a usage, and the most lines a context may have. */
const CONTEXT_RADIUS = 2;
const CONTEXT_MAX_LINES = 9;
const limitReasons = new Set(['too_large', 'max_files', 'max_total_bytes', 'unreadable']);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function usageId(repoId: string, file: string, line: number, kind: string, symbol: string): string {
  return createHash('sha256').update([repoId, file, String(line), kind, symbol].join('\0')).digest('hex').slice(0, 24);
}

function excludedDir(file: string, excludes: readonly string[]): string | null {
  const segs = file.split('/');
  const i = segs.findIndex((s) => excludes.includes(s));
  return i >= 0 ? `${segs.slice(0, i + 1).join('/')}/` : null;
}

interface Parsed {
  facts: FileFacts;
  local: unknown;
}

export async function buildUsageIndex(input: BuildInput): Promise<BuildResult> {
  const { root, repoId, repo, adapter, cache } = input;
  const read = (rel: string): string => readText(resolveInside(root, rel, repoId));
  const generated = new Set<string>();
  const unparsed: UnparsedFile[] = [];
  const parsedFiles = new Map<string, Parsed>();
  const langOf = new Map<string, LanguageAdapter>();
  const textFiles: string[] = [];
  let parsedCount = 0;
  let cachedCount = 0;

  const walked = repo.walk.files.map((f) => f).sort((a, b) => byName(a.path, b.path));
  const needed = new Set<LanguageAdapter>();
  for (const f of walked) {
    const lang = adapterFor(f.path);
    if (lang && !excludedDir(f.path, adapter.excludes)) needed.add(lang);
  }
  for (const lang of needed) await lang.init?.();

  for (const f of walked) {
    const ex = excludedDir(f.path, adapter.excludes);
    if (ex) {
      generated.add(ex);
      continue;
    }
    const lang = adapterFor(f.path);
    if (!lang) {
      textFiles.push(f.path);
      continue;
    }
    langOf.set(f.path, lang);
    const kind = lang.scriptKind(f.path);
    const factsKey = `${lang.id}@${lang.version}:${kind}`;
    const localKey = adapter.scanFile && adapter.languages.includes(lang.lang) ? `${adapter.id}@${adapter.version}+${factsKey}` : null;
    const cachedFacts = cache.get(factsKey, f.sha256);
    const cachedLocal = localKey ? cache.get(localKey, f.sha256) : undefined;
    let parsed: Parsed;
    if (cachedFacts !== undefined && (localKey === null || cachedLocal !== undefined)) {
      parsed = { facts: JSON.parse(cachedFacts) as FileFacts, local: cachedLocal === undefined ? null : JSON.parse(cachedLocal) };
      cachedCount += 1;
    } else {
      let tree;
      try {
        tree = lang.parse(resolveInside(root, f.path, repoId));
        const facts = lang.facts(tree);
        const local = localKey ? (adapter.scanFile!(tree) ?? null) : null;
        parsed = { facts, local };
      } catch (err) {
        unparsed.push({ file: f.path, lang: lang.id, line: null, message: err instanceof Error ? err.message : String(err), partial: false });
        continue;
      } finally {
        if (tree) lang.dispose?.(tree);
      }
      cache.put(factsKey, f.sha256, JSON.stringify(parsed.facts));
      if (localKey) cache.put(localKey, f.sha256, JSON.stringify(parsed.local));
      parsedCount += 1;
    }
    for (const e of parsed.facts.parse_errors.slice(0, 1)) {
      unparsed.push({ file: f.path, lang: lang.id, line: e.line, message: e.message, partial: true });
    }
    parsedFiles.set(f.path, parsed);
  }

  // Resolve every import against the walked files only.
  const fileSet: ReadonlySet<string> = new Set(walked.map((f) => f.path));
  const resolveCtx: ResolveContext = {
    root,
    repoId,
    files: fileSet,
    packages: repo.packages.map((p) => ({
      dir: p.path === '.' ? '' : p.path,
      ecosystem: p.ecosystem,
      name: p.name,
      tsconfig: p.tsconfig?.chain[0] ?? null,
    })),
    readText: read,
  };
  const resolvers = new Map<LanguageAdapter, ReturnType<LanguageAdapter['resolver']>>();
  const entries = new Map<string, FileEntry>();
  const imports: ImportRow[] = [];
  const symbols: SymbolRow[] = [];
  const unresolved: UnresolvedDynamic[] = [];
  for (const [file, parsed] of parsedFiles) {
    const lang = langOf.get(file)!;
    let resolve = resolvers.get(lang);
    if (!resolve) resolvers.set(lang, (resolve = lang.resolver(resolveCtx)));
    const resolved = parsed.facts.imports.map((d) => resolve(file, d));
    entries.set(file, { facts: parsed.facts, resolved });
    parsed.facts.imports.forEach((d, i) => {
      for (const r of resolved[i]!) {
        imports.push({ from_file: file, to_module: r.to_module, to_file: r.to_file, kind: d.kind, line: d.line, lang: lang.id, confidence: d.confidence });
      }
    });
    for (const s of parsed.facts.symbols) symbols.push({ name: s.name, file, line: s.line, kind: s.kind });
    for (const u of parsed.facts.unresolved) unresolved.push({ file, line: u.line, kind: u.kind, expr: u.expr });
  }

  const analysed = [...parsedFiles.keys()].sort(byName);
  const ctx: UsageContext = {
    root,
    repoId,
    files: analysed.filter((f) => adapter.languages.includes(langOf.get(f)!.lang)),
    textFiles,
    packages: repo.packages,
    lockfiles: repo.lockfiles,
    graph: new Graph(entries),
    edges: imports,
    targets: input.targets,
    facts: (file) => entries.get(file)?.facts ?? null,
    local: (file) => parsedFiles.get(file)?.local ?? null,
    readText: read,
    scanText: (file, patterns) => scanLines(read(file), patterns),
  };

  const detected = adapter.detect(ctx);
  const drafts: UsageDraft[] = [...detected.usages];
  // Unresolved dynamic imports in the adapter's languages are usages too, so gate 2 must account for them.
  for (const u of unresolved) {
    if (!adapter.languages.includes(langOf.get(u.file)!.lang)) continue;
    drafts.push({
      file: u.file,
      line_start: u.line,
      line_end: u.line,
      kind: 'unresolved_dynamic',
      symbol: u.expr,
      module: null,
      match_kind: null,
      via: [],
      confidence: 'heuristic',
      labels: [],
    });
  }

  const usages = finalize(repoId, drafts, read);
  const byKind: Record<string, number> = {};
  for (const u of usages) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  const sortedKinds = Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => byName(a, b)));
  return {
    usages,
    imports: imports.sort((a, b) => byName(a.from_file, b.from_file) || a.line - b.line || byName(a.to_module, b.to_module)),
    symbols: symbols.sort((a, b) => byName(a.file, b.file) || a.line - b.line || byName(a.name, b.name)),
    summary: {
      adapter: `${adapter.id}@${adapter.version}`,
      total: usages.length,
      by_kind: sortedKinds,
      files: { parsed: parsedCount, cached: cachedCount, text_only: textFiles.length },
      unparsed_files: unparsed.sort((a, b) => byName(a.file, b.file)),
      unresolved_dynamic: unresolved.sort((a, b) => byName(a.file, b.file) || a.line - b.line),
      skipped_by_limit: repo.walk.skipped.filter((s) => limitReasons.has(s.reason)).map((s) => ({ path: s.path, reason: s.reason })),
      skipped_generated: [...generated].sort(byName),
      peer_data_unavailable: [...new Set(detected.peer_data_unavailable)].sort(byName),
    },
  };
}

function finalize(repoId: string, drafts: readonly UsageDraft[], read: (rel: string) => string): Usage[] {
  const texts = new Map<string, string>();
  const textOf = (file: string): string => {
    let t = texts.get(file);
    if (t === undefined) texts.set(file, (t = read(file)));
    return t;
  };
  const byId = new Map<string, Usage>();
  for (const d of drafts) {
    const id = usageId(repoId, d.file, d.line_start, d.kind, d.symbol);
    const prev = byId.get(id);
    if (prev) {
      // The same usage reached twice (for example directly and through a barrel): keep one, with every label.
      prev.labels = [...new Set([...prev.labels, ...d.labels])].sort(byName);
      continue;
    }
    const text = textOf(d.file);
    const lineCount = text.replace(/\r\n?/g, '\n').split('\n').length;
    const end = Math.min(Math.max(d.line_end, d.line_start), lineCount);
    const ctxStart = Math.max(1, d.line_start - CONTEXT_RADIUS);
    const ctxEnd = Math.min(lineCount, end + CONTEXT_RADIUS, ctxStart + CONTEXT_MAX_LINES - 1);
    byId.set(id, {
      id,
      repo_id: repoId,
      file: d.file,
      line_start: d.line_start,
      line_end: end,
      snippet_hash: snippetHash(sliceLines(text, d.line_start, end)),
      kind: d.kind,
      symbol: d.symbol,
      module: d.module,
      match_kind: d.match_kind,
      context: sliceLines(text, ctxStart, ctxEnd),
      via: d.via,
      confidence: d.confidence,
      labels: [...new Set(d.labels)].sort(byName),
    });
  }
  return [...byId.values()].sort(
    (a, b) => byName(a.file, b.file) || a.line_start - b.line_start || byName(a.kind, b.kind) || byName(a.symbol, b.symbol),
  );
}

