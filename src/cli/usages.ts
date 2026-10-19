// `usages <repo> --source <lib@ver> --target <lib@ver>`: the CLI face of
// find_usages. The CLI keeps no state between runs, so it ingests first (the
// same run comes back for the same repo and versions), then lists usages.
import type { FindUsagesInput, FindUsagesOutput } from '../core/index.js';

export function usagesFilter(flags: { kind?: string; file?: string; symbol?: string; cursor?: string; limit?: string }): Omit<FindUsagesInput, 'run_id'> {
  const out: Omit<FindUsagesInput, 'run_id'> = {};
  if (flags.kind) out.kind = flags.kind;
  if (flags.file) out.file = flags.file;
  if (flags.symbol) out.symbol = flags.symbol;
  if (flags.cursor) out.cursor = flags.cursor;
  if (flags.limit) out.limit = Number(flags.limit);
  return out;
}

export function formatUsagesText(out: FindUsagesOutput): string {
  const s = out.summary;
  const lines = [`run ${out.run_id}: ${out.total} usages (${s.adapter}), ${s.files.parsed} files parsed, ${s.files.cached} from cache`];
  if (out.note) lines.push(out.note);
  for (const u of out.usages) {
    const tags = [u.confidence === 'heuristic' ? 'heuristic' : null, ...u.labels].filter(Boolean).join(', ');
    lines.push(`${u.file}:${u.line_start} ${u.kind} ${u.symbol}${tags ? ` (${tags})` : ''}`);
    for (const hop of u.via) lines.push(`    via ${hop.file}:${hop.line} ${hop.symbol}`);
  }
  for (const f of s.unparsed_files) lines.push(`unparsed ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}${f.partial ? ' (partial facts kept)' : ''}`);
  for (const d of s.unresolved_dynamic) lines.push(`unresolved dynamic ${d.kind} ${d.file}:${d.line}: ${d.expr}`);
  for (const k of s.skipped_by_limit) lines.push(`skipped ${k.path}: ${k.reason}`);
  for (const g of s.skipped_generated) lines.push(`not analysed (build output): ${g}`);
  for (const p of s.peer_data_unavailable) lines.push(`no peer ranges recorded in ${p}`);
  return lines.join('\n');
}
