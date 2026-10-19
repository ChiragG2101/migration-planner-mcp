// The pack update report (D11). It compares a pack's rules with the official
// notes and its seeded cases. Nothing here is committed; the maintainer
// attaches the output to the pack PR.
import { normalizeDocUrl } from '../../src/docs/officialUrl.js';
import type { ReleaseFile } from '../../src/schema/knowledge.js';
import type { Pack } from '../../src/schema/pack.js';
import type { LoadedLibrary } from '../../src/rules/compose.js';
import { compareReleaseUnits, parseVersion } from '../../src/rules/versions.js';
import { notesLocation, parseReleaseNotes } from './release-notes.js';

export interface SeededCase {
  rule_id?: string;
  expect: string;
  indirect?: boolean;
}

export interface ReportItem {
  release: string;
  title: string;
  source: string;
}

export interface PackReport {
  missing: ReportItem[];
  stale: { id: string; source: string; reason: string }[];
  drafts: { id: string; title: string; release: string }[];
  unseeded: { id: string; release: string }[];
}

const sameUrl = (a: string, b: string): boolean => {
  const na = normalizeDocUrl(a);
  const nb = normalizeDocUrl(b);
  return na !== null && na === nb;
};

/** Compares one pack's knowledge with the notes text for each release and the seeded cases. */
export function buildReport(
  pack: Pack,
  libs: ReadonlyMap<string, LoadedLibrary>,
  notes: ReadonlyMap<string, string>,
  files: readonly ReleaseFile[],
  seeded: readonly SeededCase[],
): PackReport {
  const inRange = (release: string, lib: LoadedLibrary): boolean => {
    const scheme = lib.library.version_scheme;
    const unit = lib.library.release_unit;
    const v = parseVersion(scheme, release);
    const from = pack.libraries.find((l) => l.id === lib.library.id)?.role === 'primary' ? pack.supported.from : lib.library.covered_from;
    const to = pack.libraries.find((l) => l.id === lib.library.id)?.role === 'primary' ? pack.supported.to : null;
    if (compareReleaseUnits(v, parseVersion(scheme, from), unit) < 0) return false;
    return to === null || compareReleaseUnits(v, parseVersion(scheme, to), unit) <= 0;
  };

  const missing: ReportItem[] = [];
  const stale: PackReport['stale'] = [];
  const drafts: PackReport['drafts'] = [];
  const anchorsOf = new Map<string, { page: string; anchors: Set<string> }>();

  for (const lib of libs.values()) {
    for (const rel of lib.releases) {
      if (!inRange(rel.release, lib)) continue;
      const loc = notesLocation(lib.library, rel.release);
      const text = notes.get(`${lib.library.id}@${rel.release}`);
      if (!loc || text === undefined) continue;
      const parsed = parseReleaseNotes(text, lib.library.release_notes);
      const items = parsed.items.map((i) => ({ title: i.title, source: `${loc.page}#${i.anchor}` }));
      anchorsOf.set(`${lib.library.id}@${rel.release}`, {
        page: loc.page,
        anchors: new Set([...parsed.anchors, ...parsed.items.map((i) => i.anchor)]),
      });
      const rules = files.filter((f) => f.library === lib.library.id && f.release === rel.release).flatMap((f) => f.rules);
      const allRules = files.filter((f) => f.library === lib.library.id).flatMap((f) => f.rules);
      for (const item of items) {
        if (!allRules.some((r) => sameUrl(r.source, item.source))) missing.push({ release: rel.release, title: item.title, source: item.source });
      }
      for (const rule of rules) if (rule.status === 'draft') drafts.push({ id: rule.id, title: rule.title, release: rel.release });
    }
  }

  const seededIds = new Set(seeded.filter((c) => c.expect === 'change' && c.rule_id).map((c) => c.rule_id!));
  const unseeded: PackReport['unseeded'] = [];
  for (const file of files) {
    const lib = libs.get(file.library);
    if (!lib || !inRange(file.release, lib)) continue;
    const slot = anchorsOf.get(`${file.library}@${file.release}`);
    for (const rule of file.rules) {
      if (rule.status === 'reviewed' && !seededIds.has(rule.id)) unseeded.push({ id: rule.id, release: file.release });
      if (!slot) continue;
      const hash = rule.source.split('#')[1];
      if (hash === undefined || !slot.anchors.has(hash) || !sameUrl(rule.source.split('#')[0]!, slot.page)) {
        stale.push({ id: rule.id, source: rule.source, reason: hash === undefined ? 'source has no anchor' : `anchor ${hash} is not in the ${file.release} notes` });
      }
    }
  }
  return { missing, stale, drafts, unseeded };
}

export function formatReport(pack: string, report: PackReport): string {
  const lines = [`# Pack update report: ${pack}`, ''];
  const group = (title: string, rows: string[]): void => {
    lines.push(`## ${title}`, '');
    lines.push(rows.length ? rows.map((r) => `- ${r}`).join('\n') : '- none', '');
  };
  group(
    'missing',
    report.missing.map((m) => `${m.release}: ${m.title} (${m.source})`),
  );
  group(
    'stale',
    report.stale.map((s) => `${s.id}: ${s.reason} (${s.source})`),
  );
  group(
    'drafts',
    report.drafts.map((d) => `${d.release}: ${d.id} (${d.title})`),
  );
  group(
    'unseeded',
    report.unseeded.map((u) => `${u.release}: ${u.id}`),
  );
  return lines.join('\n');
}
