// One interface for every pack's usage finder. An adapter declares the
// languages it reads, the typed rule matches it can find (M3's lint checks
// rules against them) and the usage kinds it emits (packs map them to
// lenses). It gets parsed facts, the import graph and the text scanner, and
// returns usages; the engine adds IDs, snippet hashes and context.
import type { FileFacts, Lang, SyntaxTree } from '../../lang/adapter.js';
import type { Graph } from '../../lang/graph.js';
import type { TextHit, TextPattern } from '../../lang/text.js';
import type { Lockfile } from '../../schema/scan.js';
import type { MatchKind, ViaHop } from '../../schema/usage.js';
import type { PackageFacts } from '../scanner.js';
import type { ImportRow } from '../../store/usages.js';

export interface UsageDraft {
  file: string;
  line_start: number;
  line_end: number;
  kind: string;
  symbol: string;
  module: string | null;
  match_kind: MatchKind | null;
  via: ViaHop[];
  confidence: 'exact' | 'heuristic';
  labels: string[];
}

export interface UsageContext {
  readonly root: string;
  readonly repoId: string;
  /** Files the language adapters analysed (walked, not excluded), sorted. */
  readonly files: readonly string[];
  /** Walked files no language adapter owns, sorted; the text scanner may read them. */
  readonly textFiles: readonly string[];
  readonly packages: readonly PackageFacts[];
  readonly lockfiles: readonly Lockfile[];
  readonly graph: Graph;
  readonly edges: readonly ImportRow[];
  /** Target versions by library name. M2 knows the run's target; M3 adds the companions it composes. */
  readonly targets: Readonly<Record<string, string>>;
  facts(file: string): FileFacts | null;
  /** The adapter's own per-file facts from `scanFile`, cached with the language facts. */
  local(file: string): unknown;
  /** Reads a walked file through safeRead. */
  readText(file: string): string;
  scanText(file: string, patterns: readonly TextPattern[]): TextHit[];
}

export interface DetectResult {
  usages: UsageDraft[];
  /** Lockfiles that record no peer ranges, so peer conflicts could not be checked there. */
  peer_data_unavailable: string[];
}

export interface UsageAdapter {
  readonly id: string;
  /** Bumped when detection changes, so cached per-file facts are recomputed. */
  readonly version: number;
  /** Source libraries this adapter serves until M3's pack.json names it. */
  readonly libraries: readonly string[];
  readonly languages: readonly Lang[];
  readonly match_kinds: readonly MatchKind[];
  readonly usage_kinds: readonly string[];
  /** Folder prefixes of generated output the adapter never analyses (listed in the summary, never silent). */
  readonly excludes: readonly string[];
  /** Per-file syntax facts the adapter needs beyond the language facts. Must be JSON-safe; cached by content. */
  scanFile?(tree: SyntaxTree): unknown;
  detect(ctx: UsageContext): DetectResult;
}
