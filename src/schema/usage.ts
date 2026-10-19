// find_usages: every usage a pack cares about, with file:line, a snippet hash
// and how it was reached, plus a summary that lists everything not analysed.
import { z } from 'zod';
import { MatchKind } from './match.js';
import { Confidence } from './scan.js';

/** A usage adapter declares which of the typed rule matches it can find. */
export { MatchKind };

export const ViaHop = z.object({
  file: z.string(),
  line: z.number().int(),
  symbol: z.string().describe('The binding at this hop: a re-export, a wrapper declaration or the direct use.'),
});
export type ViaHop = z.infer<typeof ViaHop>;

export const Usage = z.object({
  id: z.string().describe('Stable hash of repo, file, start line, kind and symbol.'),
  repo_id: z.string(),
  file: z.string(),
  line_start: z.number().int(),
  line_end: z.number().int(),
  snippet_hash: z.string().describe('sha256 of the normalised lines line_start..line_end (src/analysis/snippet.ts).'),
  kind: z.string().describe('The usage kind, from the adapter\'s declared usage_kinds.'),
  symbol: z.string(),
  module: z.string().nullable().describe('The module the symbol comes from, when it has one.'),
  match_kind: MatchKind.nullable().describe('The typed rule match this usage can satisfy; null for unresolved_dynamic.'),
  context: z.string().describe('At most a few lines around the usage, from a file that passed the deny list.'),
  via: z.array(ViaHop).describe('The import or call chain for an indirect usage, outermost first; empty when direct.'),
  confidence: Confidence,
  labels: z.array(z.string()).describe('Facts about the usage: indirect, type_only, awaited, peer_conflict, passed_to_client.'),
});
export type Usage = z.infer<typeof Usage>;

export const UnparsedFile = z.object({
  file: z.string(),
  lang: z.string(),
  line: z.number().int().nullable(),
  message: z.string(),
  partial: z.boolean().describe('True when the parser recovered and the facts it found are still used.'),
});
export type UnparsedFile = z.infer<typeof UnparsedFile>;

export const UnresolvedDynamic = z.object({
  file: z.string(),
  line: z.number().int(),
  kind: z.enum(['import', 'require', 'importlib']),
  expr: z.string(),
});
export type UnresolvedDynamic = z.infer<typeof UnresolvedDynamic>;

export const UsageSummary = z.object({
  adapter: z.string().describe('The usage adapter and its version, for example nextjs@2; none@1 builds only the import graph.'),
  total: z.number().int(),
  by_kind: z.record(z.string(), z.number().int()),
  files: z.object({
    parsed: z.number().int(),
    cached: z.number().int().describe('Files whose facts came from the sha256 cache, without parsing.'),
    text_only: z.number().int().describe('Files no language adapter owns, read only by the text scanner.'),
  }),
  unparsed_files: z.array(UnparsedFile),
  unresolved_dynamic: z.array(UnresolvedDynamic),
  skipped_by_limit: z.array(z.object({ path: z.string(), reason: z.string() })),
  skipped_generated: z.array(z.string()).describe('Build-output folders the adapter does not analyse (for example .next/).'),
  peer_data_unavailable: z.array(z.string()).describe('Lockfiles that record no peer ranges, so peer conflicts could not be checked there.'),
  duration_ms: z.number().int(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const FindUsagesInput = z.object({
  run_id: z.string().min(1),
  kind: z.string().optional().describe('Only usages of this kind.'),
  file: z.string().optional().describe('Only usages in this repo-relative file.'),
  symbol: z.string().optional().describe('Only usages of this symbol.'),
  cursor: z.string().optional().describe('The next_cursor of a previous page. Without it the usages are recomputed.'),
  limit: z.number().int().min(1).max(1000).optional().describe('Usages per page (default 200).'),
});
export type FindUsagesInput = z.infer<typeof FindUsagesInput>;

export const FindUsagesOutput = z.object({
  run_id: z.string(),
  total: z.number().int().describe('Usages matching the filters, across all pages.'),
  returned: z.number().int(),
  paginated: z.boolean(),
  next_cursor: z.string().nullable(),
  note: z.string().nullable().describe('Says when the result is one page of several.'),
  usages: z.array(Usage),
  summary: UsageSummary,
});
export type FindUsagesOutput = z.infer<typeof FindUsagesOutput>;
