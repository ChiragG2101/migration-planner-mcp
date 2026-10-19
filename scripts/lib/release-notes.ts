// Plain parser for official release notes (md, mdx, rst). No model (C7).
// A configured section's child headings are the change items, or its bullets
// when it has no child headings. "*" means the document itself. Headings in
// `skip` are never items. A heading that is neither a section, a skip, nor
// part of an item is reported as unknown, never guessed into a rule.
import type { Library } from '../../src/schema/knowledge.js';

export type NotesFormat = 'md' | 'mdx' | 'rst';
export type SectionEvent = 'removed' | 'deprecated' | 'changed';

export interface NotesSection {
  heading: string;
  event?: SectionEvent;
}

export interface NotesConfig {
  format: NotesFormat;
  sections: readonly NotesSection[];
  skip: readonly string[];
}

export interface NotesItem {
  /** The item's heading or bullet text, with markup trimmed. */
  title: string;
  /** The anchor on the public page: an explicit id, or a slug of the title. */
  anchor: string;
  /** The configured section it came from ("*" for the document itself). */
  section: string;
  /** The section's event, when it names one. */
  event?: SectionEvent;
}

export interface NotesParse {
  items: NotesItem[];
  /** Headings the config neither lists nor skips. Reported, never drafted. */
  unknown: string[];
  /** Every heading anchor in the document, so a rule can be checked for a dead link. */
  anchors: string[];
}

interface Heading {
  level: number;
  title: string;
  anchor: string;
  /** Bullet lines that sit directly under this heading, before the next heading. */
  bullets: string[];
}

const norm = (s: string): string =>
  s
    .replace(/`+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** A URL fragment from a heading: lowercase, dashes, no markup. */
export function slugAnchor(title: string): string {
  return norm(title)
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripFence(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const open = /^(`{3,}|~{3,})/.exec(line.trim());
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function cleanTitle(raw: string): { title: string; anchor: string | null } {
  let anchor: string | null = null;
  const title = raw
    .replace(/\{#([A-Za-z0-9_-]+)\}/g, (_m, id: string) => {
      anchor = id;
      return '';
    })
    .replace(/\{\/\*\s*([A-Za-z0-9_-]+)\s*\*\/\}/g, (_m, id: string) => {
      anchor = id;
      return '';
    })
    .replace(/\s+#([A-Za-z0-9_-]+)\s*$/, (_m, id: string) => {
      anchor = id;
      return '';
    })
    .trim();
  return { title: norm(title) === '' ? raw.trim() : title.replace(/\s+/g, ' ').trim(), anchor };
}

function displayTitle(raw: string): string {
  return raw
    .replace(/`+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingsMd(text: string): Heading[] {
  const lines = stripFence(text).split('\n');
  const headings: Heading[] = [];
  let pendingAnchor: string | null = null;
  const push = (level: number, raw: string): void => {
    const cleaned = cleanTitle(raw);
    headings.push({
      level,
      title: displayTitle(cleaned.title),
      anchor: cleaned.anchor ?? pendingAnchor ?? slugAnchor(cleaned.title),
      bullets: [],
    });
    pendingAnchor = null;
  };
  for (const line of lines) {
    const anchorOnly = /^\s*\{\/\*\s*([A-Za-z0-9_-]+)\s*\*\/\}\s*$/.exec(line);
    if (anchorOnly) {
      pendingAnchor = anchorOnly[1]!;
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      push(h[1]!.length, h[2]!);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+\S)/.exec(line);
    const current = headings.at(-1);
    if (bullet && current && current.bullets.length < 40) current.bullets.push(displayTitle(cleanTitle(bullet[1]!).title));
    else if (line.trim() !== '') pendingAnchor = null;
  }
  return headings;
}

const RST_UNDERLINE = /^(=|-|~|\^|"|')\1{2,}\s*$/;

function headingsRst(text: string): Heading[] {
  const lines = text.split(/\r?\n/);
  const headings: Heading[] = [];
  const rank = new Map<string, number>();
  let pendingAnchor: string | null = null;
  let skippingLiteral = false;
  let literalIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (skippingLiteral) {
      if (line.trim() === '') continue;
      if (/^\s/.test(line) && line.length - line.trimStart().length >= literalIndent) continue;
      skippingLiteral = false;
    }
    const explicit = /^\.\.\s+_([A-Za-z0-9_-]+):\s*$/.exec(line.trim());
    if (explicit) {
      pendingAnchor = explicit[1]!;
      continue;
    }
    if (/^\.\.\s+(code-block|code|sourcecode)::/.test(line.trim()) || /::$/.test(line.trim())) {
      skippingLiteral = true;
      literalIndent = 1;
      pendingAnchor = null;
      continue;
    }
    const next = lines[i + 1];
    if (next && RST_UNDERLINE.test(next) && line.trim() !== '') {
      const char = next.trim()[0]!;
      if (!rank.has(char)) rank.set(char, rank.size + 1);
      const cleaned = cleanTitle(line.trim());
      headings.push({
        level: rank.get(char)!,
        title: displayTitle(cleaned.title),
        anchor: cleaned.anchor ?? pendingAnchor ?? slugAnchor(cleaned.title),
        bullets: [],
      });
      pendingAnchor = null;
      i += 1;
      continue;
    }
    const bullet = /^\s*\*\s+(.+\S)/.exec(line);
    const current = headings.at(-1);
    if (bullet && current && current.bullets.length < 40) current.bullets.push(displayTitle(cleanTitle(bullet[1]!).title));
    else if (line.trim() !== '') pendingAnchor = null;
  }
  return headings;
}

interface Node {
  heading: Heading | null;
  children: Node[];
}

function tree(headings: readonly Heading[]): Node {
  const root: Node = { heading: null, children: [] };
  const stack: { level: number; node: Node }[] = [{ level: 0, node: root }];
  for (const h of headings) {
    while (stack.length > 1 && stack.at(-1)!.level >= h.level) stack.pop();
    const node: Node = { heading: h, children: [] };
    stack.at(-1)!.node.children.push(node);
    stack.push({ level: h.level, node });
  }
  return root;
}

/** Parses notes into change items plus the headings the config does not account for. */
export function parseReleaseNotes(text: string, config: NotesConfig): NotesParse {
  const headings = config.format === 'rst' ? headingsRst(text) : headingsMd(text);
  const root = tree(headings);
  const skip = new Set(config.skip.map(norm));
  const sections = new Map(config.sections.map((s) => [norm(s.heading), s]));
  const items: NotesItem[] = [];
  const claimed = new Set<Heading>();
  const visited = new Set<Node>();

  const skipped = (node: Node): boolean => node.heading !== null && skip.has(norm(node.heading.title));

  const item = (h: Heading, section: NotesSection): NotesItem => ({
    title: h.title,
    anchor: h.anchor,
    section: section.heading,
    ...(section.event ? { event: section.event } : {}),
  });

  const take = (node: Node, section: NotesSection): void => {
    if (node.heading) claimed.add(node.heading);
    const kids = node.children.filter((c) => c.heading && !skip.has(norm(c.heading.title)));
    if (kids.length > 0) {
      for (const kid of kids) {
        const h = kid.heading!;
        // A heading that is its own configured section is visited on its own,
        // so its children become that section's items rather than this one's.
        if (sections.has(norm(h.title)) && norm(h.title) !== norm(section.heading)) {
          visit(kid);
          continue;
        }
        claimed.add(h);
        for (const desc of descendants(kid)) claimed.add(desc);
        items.push(item(h, section));
      }
      return;
    }
    const bullets = node.heading?.bullets ?? [];
    if (bullets.length > 0) {
      for (const bullet of bullets) {
        items.push({ title: bullet, anchor: slugAnchor(bullet), section: section.heading, ...(section.event ? { event: section.event } : {}) });
      }
      return;
    }
    // No children and no bullets: the heading is itself the change.
    if (node.heading && section.heading !== '*') items.push(item(node.heading, section));
  };

  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (skipped(node)) {
      if (node.heading) claimed.add(node.heading);
      for (const child of node.children) {
        // A configured section stays findable even when a skipped heading wraps it.
        if (child.heading && sections.has(norm(child.heading.title))) visit(child);
        else for (const desc of descendants(child)) claimed.add(desc);
      }
      return;
    }
    if (node.heading && sections.has(norm(node.heading.title))) {
      take(node, sections.get(norm(node.heading.title))!);
      return;
    }
    for (const child of node.children) visit(child);
  };

  if (sections.has('*')) take(root, sections.get('*')!);
  for (const child of root.children) visit(child);

  const unknown: string[] = [];
  for (const h of headings) {
    if (claimed.has(h) || skip.has(norm(h.title)) || sections.has(norm(h.title))) continue;
    unknown.push(h.title);
  }
  return { items, unknown, anchors: headings.map((h) => h.anchor) };
}

function descendants(node: Node): Heading[] {
  const out: Heading[] = [];
  const walk = (n: Node): void => {
    if (n.heading) out.push(n.heading);
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return out;
}

/** The fetch and page URLs for one release, from the templates or an override. */
export function notesLocation(library: Library, release: string): { fetch: string; page: string } | null {
  const notes = library.release_notes;
  const over = notes.overrides?.[release];
  if (over) return over;
  if (!notes.fetch || !notes.page) return null;
  return { fetch: notes.fetch.replaceAll('{version}', release), page: notes.page.replaceAll('{version}', release) };
}

/** The rule event a section's event guesses. A section with no event guesses a behaviour change. */
export function guessedEvent(event: SectionEvent | undefined): 'removed' | 'deprecated' | 'changed_behavior' {
  if (event === 'removed') return 'removed';
  if (event === 'deprecated') return 'deprecated';
  return 'changed_behavior';
}
