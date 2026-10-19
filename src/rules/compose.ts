// Range composition (docs/design.md D10, D13; INV-37). For an installed
// version S and a target T, a rule applies when at least one of its events
// falls in (S, T]. Its `necessity` and `lands_on` are derived from those
// events and `replacement_since`, never read from a field. A pack composes its
// primary library, then each companion from its installed version to the
// lowest version that satisfies every `requires` range of the primary's
// peer_requirement rules in range.
import type { LaterEvent, Library, ReviewedRule, RuleEvent } from '../schema/knowledge.js';
import type { Pack } from '../schema/pack.js';
import { InputError, NotBuiltError } from '../security/errors.js';
import { compareReleaseUnits, compareVersions, lowestSatisfying, parseVersion, satisfies, type Version } from './versions.js';

/** A library's reviewed knowledge, as the loader hands it over (drafts already dropped). */
export interface LoadedLibrary {
  readonly library: Library;
  readonly releases: readonly { readonly release: string; readonly rules: readonly ReviewedRule[]; readonly events: readonly LaterEvent[] }[];
}

export type Necessity = 'breaks' | 'deprecated';
export type LandsOn = 'source' | 'target';

export interface EventAt {
  readonly event: RuleEvent;
  readonly version: string;
  readonly release: string;
}

export interface ComposedRule {
  readonly rule: ReviewedRule;
  readonly library: string;
  /** The release file the rule is defined in. */
  readonly defined_in: string;
  /** Every event of the rule, oldest first. */
  readonly events: readonly EventAt[];
  /** The events in (S, T]; at least one. */
  readonly in_range: readonly EventAt[];
  readonly necessity: Necessity;
  readonly lands_on: LandsOn;
}

export type NoteKind =
  | 'not_checked_before'
  | 'older_than_supported'
  | 'companion_not_needed'
  | 'companion_installed_unknown'
  | 'companion_unsatisfiable'
  | 'requirement_may_not_be_needed';

export interface Note {
  readonly kind: NoteKind;
  readonly library: string;
  readonly message: string;
  readonly rule_id?: string;
}

/** The upper bound: a concrete target version, or a release unit (from `stop_at`) that includes all of its versions. */
export type TargetBound = { readonly version: string } | { readonly stop_at: string };

export interface LibraryComposition {
  readonly library: string;
  readonly from: string;
  readonly to: string;
  readonly rules: readonly ComposedRule[];
  readonly notes: readonly Note[];
}

const breaking: ReadonlySet<RuleEvent> = new Set(['removed', 'renamed', 'changed_behavior', 'changed_default', 'peer_requirement']);

/** Every event of every rule in the library, keyed by rule ID. */
function eventsByRule(lib: LoadedLibrary): Map<string, { rule: ReviewedRule; defined_in: string; events: EventAt[] }> {
  const out = new Map<string, { rule: ReviewedRule; defined_in: string; events: EventAt[] }>();
  for (const r of lib.releases) {
    for (const rule of r.rules) out.set(rule.id, { rule, defined_in: r.release, events: [{ event: rule.event, version: rule.version ?? r.release, release: r.release }] });
  }
  for (const r of lib.releases) {
    for (const e of r.events) out.get(e.rule)?.events.push({ event: e.event, version: e.version ?? r.release, release: r.release });
  }
  return out;
}

/** Composes one library's rules for installed `installed` and target `target`. */
export function composeLibrary(lib: LoadedLibrary, installed: string, target: TargetBound): LibraryComposition {
  const { library } = lib;
  const scheme = library.version_scheme;
  const unit = library.release_unit;
  const S = parseVersion(scheme, installed);
  const bound = 'version' in target ? parseVersion(scheme, target.version) : parseVersion(scheme, target.stop_at);
  const atOrBelowT = (v: Version): boolean =>
    'version' in target ? compareVersions(v, bound) <= 0 : compareReleaseUnits(v, bound, unit) <= 0;

  const rules: ComposedRule[] = [];
  for (const { rule, defined_in, events } of eventsByRule(lib).values()) {
    const sorted = [...events].sort((a, b) => compareVersions(parseVersion(scheme, a.version), parseVersion(scheme, b.version)));
    const in_range = sorted.filter((e) => {
      const v = parseVersion(scheme, e.version);
      return compareVersions(v, S) > 0 && atOrBelowT(v);
    });
    if (!in_range.length) continue;
    const necessity: Necessity = in_range.some((e) => breaking.has(e.event)) ? 'breaks' : 'deprecated';
    const since = rule.replacement_since === undefined ? null : parseVersion(scheme, rule.replacement_since);
    const lands_on: LandsOn = since !== null && compareVersions(since, S) <= 0 ? 'source' : 'target';
    rules.push({ rule, library: library.id, defined_in, events: sorted, in_range, necessity, lands_on });
  }
  rules.sort((a, b) => (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));

  const notes: Note[] = [];
  if (compareReleaseUnits(S, parseVersion(scheme, library.covered_from), unit) < 0) {
    notes.push({
      kind: 'not_checked_before',
      library: library.id,
      message: `changes before ${library.covered_from} were not checked (installed ${installed})`,
    });
  }
  return { library: library.id, from: installed, to: 'version' in target ? target.version : target.stop_at, rules, notes };
}

export interface PackInput {
  /** The installed version of each library the pack names, by library ID; null when the lockfile pins none. */
  readonly installed: Readonly<Record<string, string | null>>;
  readonly target: string;
  readonly stop_at?: string;
  /** Whether a rule's match finds anything in the run; without it no "may not be needed" notes are given. */
  readonly matched?: (rule: ReviewedRule) => boolean;
}

export interface PackComposition {
  readonly libraries: readonly LibraryComposition[];
  readonly notes: readonly Note[];
  /** Target versions by package name, for find_usages's peer_conflict labels (D27). */
  readonly targets: Readonly<Record<string, string>>;
}

export const newerThanSupported = (t: string, to: string): string => `target ${t} is newer than this pack has been checked for (up to ${to})`;

/** Checks a target against the pack's `supported` range by release unit; throws the refusal. */
export function checkTarget(pack: Pack, primary: Library, target: string): Version {
  const T = parseVersion(primary.version_scheme, target);
  if (compareReleaseUnits(T, parseVersion(primary.version_scheme, pack.supported.to), primary.release_unit) > 0) {
    throw new NotBuiltError(newerThanSupported(target, pack.supported.to));
  }
  return T;
}

/** Checks a `stop_at` answer: a release unit inside the pack's supported range. */
export function checkStopAt(pack: Pack, primary: Library, stopAt: string): void {
  const s = parseVersion(primary.version_scheme, stopAt);
  const { version_scheme: scheme, release_unit: unit } = primary;
  const isUnit = s.release.length <= (unit === 'major' ? 1 : 2);
  const inside =
    compareReleaseUnits(s, parseVersion(scheme, pack.supported.from), unit) >= 0 && compareReleaseUnits(s, parseVersion(scheme, pack.supported.to), unit) <= 0;
  if (!isUnit || !inside) throw new InputError('bad_stop_at', `stop_at ${stopAt} is not a release unit inside ${pack.supported.from} to ${pack.supported.to}`);
}

/** Composes a pack: the primary from S to T (or stop_at), then each companion its peer requirements reach. */
export function composePack(pack: Pack, libs: ReadonlyMap<string, LoadedLibrary>, input: PackInput): PackComposition {
  const primaryRef = pack.libraries.find((l) => l.role === 'primary')!;
  const primary = libs.get(primaryRef.id);
  if (!primary) throw new InputError('missing_knowledge', `pack ${pack.name} names ${primaryRef.id}, which has no knowledge`);
  const { version_scheme: scheme, release_unit: unit } = primary.library;
  checkTarget(pack, primary.library, input.target);
  if (input.stop_at !== undefined) checkStopAt(pack, primary.library, input.stop_at);
  const installed = input.installed[primaryRef.id];
  if (!installed) throw new InputError('unresolved_version', `no installed version for ${primaryRef.id}`);

  const notes: Note[] = [];
  if (compareReleaseUnits(parseVersion(scheme, installed), parseVersion(scheme, pack.supported.from), unit) < 0) {
    notes.push({
      kind: 'older_than_supported',
      library: primaryRef.id,
      message: `your version is older than this pack's checked range (${pack.supported.from} to ${pack.supported.to}; installed ${installed})`,
    });
  }
  const bound: TargetBound = input.stop_at !== undefined ? { stop_at: input.stop_at } : { version: input.target };
  const main = composeLibrary(primary, installed, bound);
  const compositions: LibraryComposition[] = [main];
  const targets: Record<string, string> = {};
  for (const p of primary.library.packages) targets[p] = input.stop_at ?? input.target;

  const peerRules = main.rules.filter((c) => c.rule.event === 'peer_requirement' && c.rule.requires);
  for (const c of peerRules) {
    if (input.matched && !input.matched(c.rule)) {
      notes.push({
        kind: 'requirement_may_not_be_needed',
        library: c.rule.requires!.library,
        rule_id: c.rule.id,
        message: `${c.rule.id} requires ${c.rule.requires!.library} ${c.rule.requires!.range}, but its match found nothing in this repo; the companion upgrade may not be needed`,
      });
    }
  }

  for (const ref of pack.libraries.filter((l) => l.role === 'companion')) {
    const lib = libs.get(ref.id);
    if (!lib) throw new InputError('missing_knowledge', `pack ${pack.name} names ${ref.id}, which has no knowledge`);
    const ranges = peerRules.filter((c) => c.rule.requires!.library === ref.id).map((c) => c.rule.requires!.range);
    if (!ranges.length) continue;
    const cScheme = lib.library.version_scheme;
    const lowest = lowestSatisfying(cScheme, ranges);
    if (!lowest) {
      notes.push({ kind: 'companion_unsatisfiable', library: ref.id, message: `no ${ref.id} version satisfies every requirement (${ranges.join(', ')})` });
      continue;
    }
    const cInstalled = input.installed[ref.id];
    if (!cInstalled) {
      notes.push({ kind: 'companion_installed_unknown', library: ref.id, message: `no lockfile pins ${ref.id}, so its changes up to ${lowest.text} were not composed` });
      for (const p of lib.library.packages) targets[p] = lowest.text;
      continue;
    }
    const cv = parseVersion(cScheme, cInstalled);
    if (ranges.every((r) => satisfies(cv, r))) {
      notes.push({ kind: 'companion_not_needed', library: ref.id, message: `installed ${ref.id} ${cInstalled} already satisfies ${ranges.join(', ')}` });
      continue;
    }
    const cTarget = compareVersions(lowest, cv) > 0 ? lowest.text : cInstalled;
    for (const p of lib.library.packages) targets[p] = cTarget;
    compositions.push(composeLibrary(lib, cInstalled, { version: cTarget }));
  }

  return { libraries: compositions, notes: [...notes, ...compositions.flatMap((c) => c.notes)], targets };
}
