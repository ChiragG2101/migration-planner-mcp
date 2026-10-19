// Pack reference files as MCP resources (M3 task 9). get_rule_pack returns the
// URIs; the server registers them, and a read goes through the bundled-data
// reader, so only a real Markdown file under packs/<pack>/references/ is served.
import { BUNDLED_ROOT, readDataTree } from '../security/dataFiles.js';

const nameRe = /^[a-z0-9][a-z0-9-]*$/;
const fileRe = /^\/references\/([A-Za-z0-9._-]+\.md)$/;

export interface PackReference {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
}

/** `pack://<pack>/references/<file>`, the URI get_rule_pack and the server share. */
export const referenceUri = (pack: string, file: string): string => `pack://${pack}/references/${file}`;

/** Every generated reference file under the bundled packs. */
export function listPackReferences(root = BUNDLED_ROOT): PackReference[] {
  return readDataTree(root, 'packs')
    .filter((f) => /^packs\/[^/]+\/references\/[^/]+\.md$/.test(f.path) && f.text !== null)
    .map((f) => {
      const [, pack, file] = /^packs\/([^/]+)\/references\/([^/]+)$/.exec(f.path)!;
      return { name: `${pack}-${file!.replace(/\.md$/, '')}`, uri: referenceUri(pack!, file!), title: `${pack} ${file}` };
    });
}

/**
 * The text of a reference URI, or null when it is not one bundled reference file.
 * A `..` path, another scheme or a non-markdown name does not match.
 */
export function readPackReference(raw: string, root = BUNDLED_ROOT): string | null {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return null;
  }
  const file = fileRe.exec(uri.pathname);
  if (uri.protocol !== 'pack:' || !nameRe.test(uri.hostname) || !file) return null;
  const rel = `packs/${uri.hostname}/references/${file[1]}`;
  return readDataTree(root, 'packs').find((f) => f.path === rel)?.text ?? null;
}
