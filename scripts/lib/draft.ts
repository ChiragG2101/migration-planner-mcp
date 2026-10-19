// Turns one release's official notes into draft rules. It only adds rules:
// an existing rule, reviewed or still a draft, is left as it is.
import type { Library, ReleaseFile, Rule } from '../../src/schema/knowledge.js';
import { guessedEvent, notesLocation, parseReleaseNotes, slugAnchor } from './release-notes.js';

export interface DraftResult {
  file: ReleaseFile;
  added: string[];
  /** Existing rule ids the notes also describe; never rewritten. */
  kept: string[];
  unknown: string[];
}

const ruleId = (library: string, title: string, taken: Set<string>): string => {
  const prefix = library.split('/')[1]!;
  let slug = slugAnchor(title).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!/^[a-z0-9]/.test(slug)) slug = `change-${slug}`.replace(/-+$/g, '');
  let id = `${prefix}/${slug}`;
  let n = 2;
  while (taken.has(id)) id = `${prefix}/${slug}-${n++}`;
  return id;
};

/** Merges the notes' items into the release file. `page` is the public URL the anchors hang off. */
export function draftFromNotes(library: Library, release: string, notes: string, page: string, existing: ReleaseFile | null): DraftResult {
  const parsed = parseReleaseNotes(notes, library.release_notes);
  const rules: Rule[] = existing ? [...existing.rules] : [];
  const taken = new Set(rules.map((r) => r.id));
  const added: string[] = [];
  const kept: string[] = [];
  const seenAnchor = new Set<string>();
  for (const item of parsed.items) {
    if (seenAnchor.has(item.anchor)) continue;
    seenAnchor.add(item.anchor);
    const source = `${page}#${item.anchor}`;
    const already = rules.find((r) => r.source === source || r.title === item.title);
    if (already) {
      kept.push(already.id);
      continue;
    }
    const id = ruleId(library.id, item.title, taken);
    taken.add(id);
    rules.push({ id, title: item.title, event: guessedEvent(item.event), source, status: 'draft' });
    added.push(id);
  }
  return {
    file: { library: library.id, release, rules, events: existing?.events ?? [] },
    added,
    kept,
    unknown: parsed.unknown,
  };
}

export function pageFor(library: Library, release: string): string {
  const loc = notesLocation(library, release);
  if (!loc) throw new Error(`${library.id} ${release} has no release notes location`);
  return loc.page;
}
