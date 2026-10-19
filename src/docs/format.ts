// Compact old/new sections, and the "docs unverified" badge M5 and M9 consume.
import type { Match } from '../schema/match.js';
import type { DocStatus } from '../store/docs.js';

export const DOCS_UNVERIFIED = 'docs unverified';

/** True when every cited doc is stale or unverified. One fresh doc keeps the badge off. */
export function docsUnverifiedBadge(cited: readonly { status: DocStatus }[]): boolean {
  return cited.length > 0 && cited.every((d) => d.status === 'stale' || d.status === 'unverified');
}

/** The symbol a server-side query may send: a module, name, setting or config key. Never doc_topics. */
export function symbolOf(match: Match): string {
  switch (match.kind) {
    case 'import':
      return match.name ?? match.module;
    case 'call':
      return match.name;
    case 'attribute':
      return match.path;
    case 'config_key':
      return match.path;
    case 'setting':
      return match.name;
    case 'string_ref':
      return match.dotted_path;
    case 'template_tag':
    case 'template_filter':
      return match.name;
    case 'dependency':
      return match.package;
    case 'file_convention':
      return match.symbol ?? match.glob;
  }
}

export interface FormattedDoc {
  topic: string;
  library: string;
  version: string;
  content: string;
  status: DocStatus;
  doc_id: string;
  url: string;
  fetched_by: string;
  official: boolean;
}

/** One section per topic, with the installed version on the old side and the target on the new side. */
export function formatDocs(docs: readonly FormattedDoc[], oldVersions: ReadonlySet<string>, newVersions: ReadonlySet<string>): string {
  const groups = new Map<string, FormattedDoc[]>();
  for (const doc of docs) {
    const key = `${doc.library}\n${doc.topic}`;
    const list = groups.get(key);
    if (list) list.push(doc);
    else groups.set(key, [doc]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const [library, topic] = key.split('\n');
      const blocks = list.map((doc) => {
        const side = oldVersions.has(doc.version) ? 'old' : newVersions.has(doc.version) ? 'new' : doc.version;
        return [
          `### ${side} (${library}@${doc.version}) — ${doc.status}`,
          `doc_id: ${doc.doc_id}`,
          `url: ${doc.url}`,
          `fetched_by: ${doc.fetched_by}`,
          `official: ${doc.official}`,
          '',
          doc.content,
        ].join('\n');
      });
      return [`## ${library} ${topic}`, ...blocks].join('\n\n');
    })
    .join('\n\n');
}
