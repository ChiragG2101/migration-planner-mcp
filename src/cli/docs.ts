// Text form of get_migration_docs. The JSON form is the tool output unchanged.
import type { GetMigrationDocsOutput } from '../schema/docs.js';

export function formatDocsText(out: GetMigrationDocsOutput): string {
  const lines = [out.formatted];
  if (out.fallback) lines.push('', `fallback: ${out.fallback.reason}`);
  for (const limit of out.limits) lines.push('', limit);
  return lines.join('\n');
}
