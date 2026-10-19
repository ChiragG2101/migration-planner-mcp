// C6: the engine's own network has one allowlisted host. Anything else throws
// before a request is made. Context7 is the only caller (src/docs/context7.ts).
import { PermissionError } from './errors.js';

/** The only host the engine may contact. */
export const CONTEXT7_HOST = 'mcp.context7.com';

/** The Context7 MCP endpoint. Re-checked against the upstream server at the start of M4. */
export const CONTEXT7_URL = 'https://mcp.context7.com/mcp';

/** Accepts only https://mcp.context7.com. Look-alike hosts, other schemes and credentials are refused. */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermissionError('network', `refused network url: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname !== CONTEXT7_HOST) {
    throw new PermissionError('network', `refused network host: ${url.hostname || raw}`);
  }
  return url;
}
