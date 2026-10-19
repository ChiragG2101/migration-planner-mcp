// Pack and knowledge lint (M3 task 7). It runs in `npm run lint` and in CI.
// One message per problem, each naming the file. With --base (or BASE_SHA),
// a pack whose pack.json or knowledge changed must also have bumped its version.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docSourceProblem, isOfficialUrl } from '../src/docs/officialUrl.js';
import { usageAdapterById } from '../src/analysis/usages/index.js';
import { Library, ReleaseFile, type Rule } from '../src/schema/knowledge.js';
import { Pack } from '../src/schema/pack.js';
import { isKnownCodemod } from '../src/verify/codemodIds.js';
import { compareReleaseUnits, parseVersion } from '../src/rules/versions.js';

export interface VersionBase {
  /** Repo-relative paths changed since the base. */
  changed: readonly string[];
  /** Each pack's version at the base, or null when the pack is new. */
  versions: Readonly<Record<string, string | null>>;
}

const DISPLAY_KEYS = new Set(['verify_hint', 'rollback_hint', 'checks_hint']);
const commandRe = /(?:^|\s)(?:npm|npx|yarn|pnpm|bun|node|python3?|pip3?|uv|django-admin|rm|curl|wget|bash|sh|sudo)\s+\S/;
const SKILL_LINE_LIMIT = 100;

const relPosix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

function walkFiles(dir: string): string[] {
  if (!statExists(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Lints the knowledge and packs under `root`. `base` adds the version-bump check CI runs. */
export function lintPacks(root: string, base?: VersionBase): string[] {
  const problems: string[] = [];
  const fail = (file: string, message: string): void => void problems.push(`${relPosix(root, file)}: ${message}`);

  for (const abs of [...walkFiles(path.join(root, 'knowledge')), ...walkFiles(path.join(root, 'packs'))]) {
    if (!/\.(json|md)$/.test(abs)) fail(abs, 'only .json and .md files are allowed under knowledge/ and packs/');
  }

  const libraries = new Map<string, { library: Library; file: string; dir: string }>();
  for (const abs of walkFiles(path.join(root, 'knowledge')).filter((f) => f.endsWith(`${path.sep}library.json`))) {
    const library = readSchema(abs, Library, fail);
    if (!library) continue;
    libraries.set(library.id, { library, file: abs, dir: path.dirname(abs) });
    if (library.doc_sources.length === 0) fail(abs, 'doc_sources is empty');
    for (const prefix of library.doc_sources) {
      const why = docSourceProblem(prefix);
      if (why) fail(abs, why);
    }
    for (const c of library.codemods) if (!isKnownCodemod(c.id)) fail(abs, `codemod ${c.id} is not in the core registry`);
    scanCommands(library, abs, fail);
    const changelog = path.join(path.dirname(abs), 'CHANGELOG.md');
    if (!statExists(changelog)) fail(abs, 'library CHANGELOG.md is missing');
  }

  const rules = new Map<string, { file: string; rule: Rule; release: string; library: string }>();
  const events: { file: string; library: string; release: string; rule: string; version?: string }[] = [];
  for (const abs of walkFiles(path.join(root, 'knowledge')).filter((f) => f.endsWith('.json') && !f.endsWith(`${path.sep}library.json`))) {
    const file = readSchema(abs, ReleaseFile, fail);
    if (!file) continue;
    const lib = libraries.get(file.library);
    if (!lib) {
      fail(abs, `no library.json for ${file.library}`);
      continue;
    }
    scanCommands(file, abs, fail);
    for (const rule of file.rules) {
      const prev = rules.get(rule.id);
      if (prev) fail(abs, `rule ${rule.id} is also defined in ${relPosix(root, prev.file)}`);
      else rules.set(rule.id, { file: abs, rule, release: file.release, library: file.library });
      if (rule.codemod) {
        if (!isKnownCodemod(rule.codemod)) fail(abs, `codemod ${rule.codemod} is not in the core registry`);
        if (!lib.library.codemods.some((c) => c.id === rule.codemod)) fail(abs, `codemod ${rule.codemod} is not listed by ${file.library}`);
      }
      if (!isOfficialUrl(rule.source, lib.library.doc_sources)) fail(abs, `source ${rule.source} is not under ${file.library}'s doc_sources`);
    }
    for (const e of file.events) {
      events.push({ file: abs, library: file.library, release: file.release, rule: e.rule, ...(e.version ? { version: e.version } : {}) });
      if (e.version && !sameUnit(lib.library, e.version, file.release)) fail(abs, `event for ${e.rule} at ${e.version} is not inside release ${file.release}`);
    }
  }
  for (const e of events) {
    if (!rules.has(e.rule)) fail(e.file, `event for unknown rule ${e.rule}`);
  }
  for (const lib of libraries.values()) {
    const covered = parseVersion(lib.library.version_scheme, lib.library.covered_from);
    for (const [id, rec] of rules) {
      if (rec.library !== lib.library.id) continue;
      if (compareReleaseUnits(parseVersion(lib.library.version_scheme, rec.release), covered, lib.library.release_unit) >= 0) continue;
      const later = events.some(
        (e) =>
          e.rule === id &&
          e.library === lib.library.id &&
          compareReleaseUnits(parseVersion(lib.library.version_scheme, e.release), covered, lib.library.release_unit) >= 0,
      );
      if (!later) fail(rec.file, `rule ${id} is older than covered_from ${lib.library.covered_from} and has no event at or after it`);
    }
  }

  for (const abs of walkFiles(path.join(root, 'packs')).filter((f) => f.endsWith(`${path.sep}pack.json`))) {
    const pack = readSchema(abs, Pack, fail);
    if (!pack) continue;
    const dir = path.dirname(abs);
    scanCommands(pack, abs, fail);
    lintTrigger(pack, abs, fail);
    const changelog = path.join(dir, 'CHANGELOG.md');
    if (!statExists(changelog) || !readFileSync(changelog, 'utf8').includes(pack.version)) fail(changelog, `CHANGELOG.md does not mention ${pack.version}`);
    lintSkill(dir, pack, fail);
    const primary = libraries.get(pack.libraries.find((l) => l.role === 'primary')!.id);
    if (!primary) {
      fail(abs, 'primary library has no knowledge');
      continue;
    }
    const adapter = usageAdapterById(pack.usage_adapter);
    if (!adapter) fail(abs, `usage_adapter ${pack.usage_adapter} is not registered`);
    const newest = newestReviewed(primary.library, rules);
    const scheme = primary.library.version_scheme;
    const unit = primary.library.release_unit;
    if (compareReleaseUnits(parseVersion(scheme, pack.supported.from), parseVersion(scheme, primary.library.covered_from), unit) < 0) {
      fail(abs, `supported.from ${pack.supported.from} is older than covered_from ${primary.library.covered_from}`);
    }
    if (!newest || compareReleaseUnits(parseVersion(scheme, pack.supported.to), parseVersion(scheme, newest), unit) > 0) {
      fail(abs, `supported.to ${pack.supported.to} is past the newest reviewed release${newest ? ` (${newest})` : ' (none)'}`);
    }
    const seededFile = path.join(root, 'eval', 'seeded', pack.seeded, 'ground_truth.json');
    const seeded = readSeeded(seededFile);
    if (!seeded) fail(abs, `seeded repo ${pack.seeded} has no ground_truth.json`);
    for (const rec of rules.values()) {
      if (rec.rule.status !== 'reviewed' || !pack.libraries.some((l) => l.id === rec.library)) continue;
      const lib = libraries.get(rec.library)!;
      if (!reachable(lib.library, rec.release, rec.rule.id, pack, events)) continue;
      if (adapter && !adapter.match_kinds.includes(rec.rule.match.kind)) {
        fail(rec.file, `rule ${rec.rule.id} matches by ${rec.rule.match.kind}, which ${adapter.id} does not report`);
      }
      const cases = (seeded ?? []).filter((c) => c.rule_id === rec.rule.id && c.expect === 'change');
      if (!cases.length) fail(rec.file, `rule ${rec.rule.id} has no expect: change seeded case`);
      if ((rec.rule.match.kind === 'import' || rec.rule.match.kind === 'call') && !cases.some((c) => c.indirect)) {
        fail(rec.file, `rule ${rec.rule.id} is a ${rec.rule.match.kind} with no indirect seeded case`);
      }
    }
    if (base) {
      const changed = base.changed.some(
        (p) => p === relPosix(root, abs) || pack.libraries.some((l) => p.startsWith(`knowledge/${l.id}/`)),
      );
      const was = base.versions[pack.name];
      if (changed && was != null && was === pack.version) fail(abs, `version ${pack.version} was not bumped after pack or knowledge changes`);
    }
  }
  return problems;
}

function readSchema<T>(abs: string, schema: { parse: (v: unknown) => T }, fail: (f: string, m: string) => void): T | null {
  try {
    return schema.parse(JSON.parse(readFileSync(abs, 'utf8')));
  } catch (err) {
    fail(abs, err instanceof Error ? err.message.split('\n')[0]! : String(err));
    return null;
  }
}

function scanCommands(value: unknown, file: string, fail: (f: string, m: string) => void, key = ''): void {
  if (typeof value === 'string') {
    if (!DISPLAY_KEYS.has(key) && commandRe.test(value)) fail(file, `looks like a shell command in ${key || 'a value'}: ${value.slice(0, 80)}`);
    return;
  }
  if (Array.isArray(value)) for (const v of value) scanCommands(v, file, fail, key);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scanCommands(v, file, fail, k);
}

function lintTrigger(pack: Pack, file: string, fail: (f: string, m: string) => void): void {
  const trigger = pack.trigger;
  if (!trigger.startsWith('Use when ')) fail(file, 'trigger must start with "Use when "');
  const name = pack.libraries.find((l) => l.role === 'primary')!.id.split('/')[1]!;
  if (!trigger.toLowerCase().includes(name.toLowerCase())) fail(file, `trigger must name the library ${name}`);
  if (!/upgrad|migrat/i.test(trigger)) fail(file, 'trigger must name the migration');
  if (/\bany\b/i.test(trigger) || /working with/i.test(trigger)) fail(file, 'trigger is too broad');
}

function lintSkill(dir: string, pack: Pack, fail: (f: string, m: string) => void): void {
  const skill = path.join(dir, 'SKILL.md');
  if (!statExists(skill)) {
    fail(skill, 'SKILL.md is missing');
    return;
  }
  const text = readFileSync(skill, 'utf8');
  const lines = text.split('\n').length;
  if (lines > SKILL_LINE_LIMIT) fail(skill, `SKILL.md is ${lines} lines; the limit is ${SKILL_LINE_LIMIT}`);
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!text.startsWith('---\n') || !front) fail(skill, 'SKILL.md frontmatter must start on line 1, so a host reads the trigger');
  else {
    const description = /^description: (.*)$/m.exec(front[1]!)?.[1];
    if (description !== pack.trigger) fail(skill, `SKILL.md description must equal the pack trigger (${pack.trigger})`);
  }
  for (const match of text.matchAll(/\]\((references\/[^)]+)\)/g)) {
    if (!statExists(path.join(dir, match[1]!))) fail(skill, `links to ${match[1]}, which does not exist`);
  }
}

function sameUnit(library: Library, version: string, release: string): boolean {
  try {
    return compareReleaseUnits(parseVersion(library.version_scheme, version), parseVersion(library.version_scheme, release), library.release_unit) === 0;
  } catch {
    return false;
  }
}

function newestReviewed(library: Library, rules: Map<string, { rule: Rule; release: string; library: string }>): string | null {
  let best: string | null = null;
  for (const rec of rules.values()) {
    if (rec.library !== library.id || rec.rule.status !== 'reviewed') continue;
    if (!best || compareReleaseUnits(parseVersion(library.version_scheme, rec.release), parseVersion(library.version_scheme, best), library.release_unit) > 0) {
      best = rec.release;
    }
  }
  return best;
}

function reachable(library: Library, release: string, ruleId: string, pack: Pack, events: { library: string; release: string; rule: string }[]): boolean {
  const scheme = library.version_scheme;
  const unit = library.release_unit;
  const primary = pack.libraries.find((l) => l.role === 'primary')!.id;
  // A companion is composed to whatever its peer requirements demand, so its
  // rules count from covered_from up. The primary is bounded by `supported`.
  const from = parseVersion(scheme, library.id === primary ? pack.supported.from : library.covered_from);
  const to = library.id === primary ? parseVersion(scheme, pack.supported.to) : null;
  const inside = (v: string): boolean => {
    const n = parseVersion(scheme, v);
    return compareReleaseUnits(n, from, unit) >= 0 && (to === null || compareReleaseUnits(n, to, unit) <= 0);
  };
  return inside(release) || events.some((e) => e.rule === ruleId && e.library === library.id && inside(e.release));
}

interface Seeded {
  rule_id?: string;
  expect?: string;
  indirect?: boolean;
}

function readSeeded(file: string): Seeded[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: Seeded[] };
    return parsed.entries ?? [];
  } catch {
    return null;
  }
}

function baseFromGit(repo: string, ref: string): VersionBase | undefined {
  if (!ref || /^0+$/.test(ref)) return undefined;
  const names = execFileSync('git', ['diff', '--name-only', ref, 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const versions: Record<string, string | null> = {};
  for (const name of readdirSync(path.join(repo, 'packs'))) {
    try {
      const at = execFileSync('git', ['show', `${ref}:packs/${name}/pack.json`], { cwd: repo, encoding: 'utf8' });
      versions[name] = (JSON.parse(at) as { version?: string }).version ?? null;
    } catch {
      versions[name] = null;
    }
  }
  return { changed: names, versions };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const flag = process.argv.indexOf('--base');
  const ref = flag >= 0 ? process.argv[flag + 1] : process.env.BASE_SHA;
  const base = ref ? baseFromGit(root, ref) : undefined;
  const problems = lintPacks(root, base);
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('pack lint passed\n');
}
