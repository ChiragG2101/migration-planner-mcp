// Loads knowledge and packs from the bundled `knowledge/` and `packs/` only
// (v0.1; a --rules-dir elsewhere is refused). Everything is validated with
// Zod plus the cross-file checks composition relies on; any problem stops the
// load, so the engine never runs on knowledge it couldn't read (fail closed).
// Draft rules are skipped and counted (INV-36). Each pack is recorded as
// `name@version#hash`, where the hash covers pack.json and every knowledge
// JSON file of its libraries.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Library, ReleaseFile, type LaterEvent, type ReviewedRule } from '../schema/knowledge.js';
import { Pack } from '../schema/pack.js';
import { assertBundledRulesDir, BUNDLED_ROOT, readDataTree, type DataFile } from '../security/dataFiles.js';
import { InputError } from '../security/errors.js';
import type { LoadedLibrary } from './compose.js';
import { compareReleaseUnits, compareVersions, parseVersion, validRange } from './versions.js';

export interface PackBundle {
  readonly pack: Pack;
  readonly primary: LoadedLibrary;
  readonly libs: ReadonlyMap<string, LoadedLibrary>;
  readonly hash: string;
  /** `name@version#hash`, recorded on every run. */
  readonly ref: string;
  readonly rules: number;
  readonly drafts: number;
}

export interface Bundle {
  readonly root: string;
  readonly libraries: ReadonlyMap<string, LoadedLibrary>;
  readonly packs: ReadonlyMap<string, PackBundle>;
  /** Draft rules per library ID, skipped. */
  readonly drafts: ReadonlyMap<string, number>;
}

const bad = (file: string, message: string): InputError => new InputError('bad_knowledge', `${file}: ${message}`);

function parseJson<T>(f: DataFile, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(f.text!);
  } catch (err) {
    throw bad(f.path, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw bad(f.path, z.prettifyError(r.error));
  return r.data;
}

function checkVersion(file: string, scheme: Library['version_scheme'], v: string, what: string) {
  try {
    return parseVersion(scheme, v);
  } catch (err) {
    throw bad(file, `${what} ${v}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface LibDraft {
  library: Library;
  dir: string;
  files: DataFile[];
  releases: Map<string, { rules: ReviewedRule[]; events: (LaterEvent & { file: string })[] }>;
  ruleIds: Map<string, string>;
  draftIds: Set<string>;
  drafts: number;
}

function loadLibraries(files: readonly DataFile[]): Map<string, LibDraft> {
  const libs = new Map<string, LibDraft>();
  for (const f of files.filter((x) => /^knowledge\/[^/]+\/[^/]+\/library\.json$/.test(x.path))) {
    const [, eco, name] = f.path.split('/');
    const library = parseJson(f, Library);
    if (library.id !== `${eco}/${name}` || library.ecosystem !== eco) throw bad(f.path, `id ${library.id} does not match its folder ${eco}/${name}`);
    for (const v of [library.covered_from, ...(library.lts ?? [])]) checkVersion(f.path, library.version_scheme, v, 'version');
    libs.set(library.id, {
      library,
      dir: `knowledge/${eco}/${name}`,
      files: [f],
      releases: new Map(),
      ruleIds: new Map(),
      draftIds: new Set(),
      drafts: 0,
    });
  }
  return libs;
}

function placeFile(libs: Map<string, LibDraft>, f: DataFile): { lib: LibDraft; release: string; area: string | null } | null {
  const m = /^knowledge\/([^/]+)\/([^/]+)\/(.+)$/.exec(f.path);
  if (!m) throw bad(f.path, 'knowledge files live under knowledge/<ecosystem>/<library>/');
  const lib = libs.get(`${m[1]}/${m[2]}`);
  if (!lib) throw bad(f.path, `no library.json for knowledge/${m[1]}/${m[2]}`);
  const rest = m[3]!;
  if (rest === 'library.json' || rest.endsWith('.md')) return null;
  const single = /^releases\/([^/]+)\.json$/.exec(rest);
  if (single) return { lib, release: single[1]!, area: null };
  const area = /^releases\/([^/]+)\/([^/]+)\.json$/.exec(rest);
  if (area) return { lib, release: area[1]!, area: area[2]! };
  throw bad(f.path, 'not a library.json, a releases/<release>.json or a releases/<release>/<area>.json');
}

/** Loads and checks everything under `root`'s knowledge/ and packs/. Tests pass fixture roots; the engine passes the bundled root. */
export function loadBundle(root: string): Bundle {
  const kFiles = readDataTree(root, 'knowledge');
  const pFiles = readDataTree(root, 'packs');
  for (const f of [...kFiles, ...pFiles]) if (f.text === null) throw bad(f.path, 'only .json and .md files are allowed under knowledge/ and packs/');

  const libs = loadLibraries(kFiles);
  const seenRules = new Map<string, string>();
  for (const f of kFiles) {
    const placed = placeFile(libs, f);
    if (!placed) continue;
    const { lib, release, area } = placed;
    const { version_scheme: scheme, release_unit: unit } = lib.library;
    const rf = parseJson(f, ReleaseFile);
    if (rf.library !== lib.library.id) throw bad(f.path, `library ${rf.library} does not match its folder ${lib.library.id}`);
    if (rf.release !== release) throw bad(f.path, `release ${rf.release} does not match its file name ${release}`);
    if ((rf.area ?? null) !== area) throw bad(f.path, area ? `an area file needs "area": "${area}"` : 'only area files under releases/<release>/ set "area"');
    const relV = checkVersion(f.path, scheme, rf.release, 'release');
    const inRelease = (v: string, what: string): void => {
      if (compareReleaseUnits(checkVersion(f.path, scheme, v, what), relV, unit) !== 0) throw bad(f.path, `${what} ${v} is not inside release ${rf.release}`);
    };
    const prefix = `${lib.library.id.split('/')[1]}/`;
    lib.files.push(f);
    const slot = lib.releases.get(release) ?? { rules: [], events: [] };
    lib.releases.set(release, slot);
    for (const rule of rf.rules) {
      if (!rule.id.startsWith(prefix)) throw bad(f.path, `rule ${rule.id} must start with ${prefix}`);
      const prev = seenRules.get(rule.id);
      if (prev) throw bad(f.path, `rule ${rule.id} is also defined in ${prev}`);
      seenRules.set(rule.id, f.path);
      lib.ruleIds.set(rule.id, release);
      if (rule.version !== undefined) inRelease(rule.version, `rule ${rule.id} version`);
      if (rule.status === 'draft') {
        lib.draftIds.add(rule.id);
        lib.drafts += 1;
        continue;
      }
      if (rule.replacement_since !== undefined) checkVersion(f.path, scheme, rule.replacement_since, `rule ${rule.id} replacement_since`);
      slot.rules.push(rule);
    }
    for (const e of rf.events) {
      if (e.version !== undefined) inRelease(e.version, `event for ${e.rule} version`);
      slot.events.push({ ...e, file: f.path });
    }
  }

  // Later events must name a rule defined in an earlier release of the same library.
  const loaded = new Map<string, LoadedLibrary>();
  const drafts = new Map<string, number>();
  for (const lib of libs.values()) {
    const scheme = lib.library.version_scheme;
    const order = [...lib.releases.keys()].sort((a, b) => compareVersions(parseVersion(scheme, a), parseVersion(scheme, b)));
    const releases = order.map((release) => {
      const slot = lib.releases.get(release)!;
      const events: LaterEvent[] = [];
      for (const { file, ...e } of slot.events) {
        const definedIn = lib.ruleIds.get(e.rule);
        if (definedIn === undefined) throw bad(file, `event for unknown rule ${e.rule}`);
        if (compareVersions(parseVersion(scheme, definedIn), parseVersion(scheme, release)) >= 0) {
          throw bad(file, `event for ${e.rule} must be in a later release than ${definedIn}, where it is defined`);
        }
        if (!lib.draftIds.has(e.rule)) events.push(e);
      }
      return { release, rules: slot.rules, events };
    });
    loaded.set(lib.library.id, { library: lib.library, releases });
    drafts.set(lib.library.id, lib.drafts);
  }
  for (const lib of loaded.values()) {
    for (const r of lib.releases) {
      for (const rule of r.rules) {
        if (!rule.requires) continue;
        const req = loaded.get(rule.requires.library);
        const file = `${libs.get(lib.library.id)!.dir}/releases/${r.release}`;
        if (!req) throw bad(file, `rule ${rule.id} requires unknown library ${rule.requires.library}`);
        if (!validRange(req.library.version_scheme, rule.requires.range)) throw bad(file, `rule ${rule.id} requires an invalid range ${rule.requires.range}`);
      }
    }
  }

  const packs = new Map<string, PackBundle>();
  for (const f of pFiles.filter((x) => x.path.endsWith('/pack.json'))) {
    const m = /^packs\/([^/]+)\/pack\.json$/.exec(f.path);
    if (!m) throw bad(f.path, 'pack.json lives at packs/<pack>/pack.json');
    const pack = parseJson(f, Pack);
    if (pack.name !== m[1]) throw bad(f.path, `name ${pack.name} does not match its folder ${m[1]}`);
    const packLibs = new Map<string, LoadedLibrary>();
    for (const ref of pack.libraries) {
      const l = loaded.get(ref.id);
      if (!l) throw bad(f.path, `library ${ref.id} has no knowledge`);
      packLibs.set(ref.id, l);
    }
    const primary = packLibs.get(pack.libraries.find((l) => l.role === 'primary')!.id)!;
    for (const v of [pack.supported.from, pack.supported.to]) checkVersion(f.path, primary.library.version_scheme, v, 'supported');
    const hashed = [f, ...pack.libraries.flatMap((ref) => libs.get(ref.id)!.files)].sort((a, b) => (a.path < b.path ? -1 : 1));
    const h = createHash('sha256');
    for (const x of hashed) h.update(`${x.path}\0${x.text}\0`);
    const hash = h.digest('hex');
    const ruleCount = [...packLibs.values()].reduce((n, l) => n + l.releases.reduce((k, r) => k + r.rules.length, 0), 0);
    const draftCount = pack.libraries.reduce((n, ref) => n + (drafts.get(ref.id) ?? 0), 0);
    packs.set(pack.name, { pack, primary, libs: packLibs, hash, ref: `${pack.name}@${pack.version}#${hash.slice(0, 12)}`, rules: ruleCount, drafts: draftCount });
  }
  return { root, libraries: loaded, packs, drafts };
}

/** The bundled knowledge and packs. A --rules-dir is accepted only when it is the bundled data. */
export function loadBundled(rulesDir?: string): Bundle {
  if (rulesDir !== undefined) assertBundledRulesDir(rulesDir);
  return loadBundle(BUNDLED_ROOT);
}

/** The pack whose primary library covers the package `name` (the run's source library), if any. */
export function packForLibrary(bundle: Bundle, name: string): PackBundle | undefined {
  return [...bundle.packs.values()].find((p) => p.primary.library.packages.includes(name));
}

/** One line per pack for the startup log. */
export function describeBundle(bundle: Bundle): string[] {
  return [...bundle.packs.values()].map((p) => `pack ${p.ref}: ${p.rules} reviewed rules, ${p.drafts} draft rules skipped`);
}
