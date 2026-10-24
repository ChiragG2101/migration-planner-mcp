// `scan <repo> --source <lib@ver> --target <lib@ver>`: the CLI face of scan_repo.
import type { IngestInput, ScanRepoOutput } from '../core/index.js';

/** "next@15.1.0", "@scope/pkg@1.2", "django==4.2" or a bare name. */
export function parseLibRef(raw: string | undefined): { name?: string; version?: string } | undefined {
  if (raw === undefined) return undefined;
  const eq = raw.indexOf('==');
  if (eq > 0) return { name: raw.slice(0, eq), version: raw.slice(eq + 2) };
  const at = raw.lastIndexOf('@');
  if (at > 0) return { name: raw.slice(0, at), version: raw.slice(at + 1) };
  return { name: raw };
}

export function scanInput(
  repos: string[],
  flags: { source?: string; target?: string; campaign?: string; 'confirm-target'?: boolean },
): IngestInput {
  const input: IngestInput = { repo_path: repos.length === 1 ? repos[0]! : repos };
  const source = parseLibRef(flags.source);
  const target = parseLibRef(flags.target);
  if (source) input.source = source;
  if (target) input.target = target;
  if (flags.campaign) input.campaign_id = flags.campaign;
  if (flags['confirm-target'] === true) input.confirm_target = true;
  return input;
}

export function formatScanText(out: ScanRepoOutput): string {
  if (out.status === 'question' || !out.scan || !out.run) {
    const q = out.question!;
    const lines = [`Question (${q.kind}, ${q.field}): ${q.message}`];
    for (const c of q.candidates) lines.push(`  - ${c.value}: ${c.where.join(', ')}`);
    return lines.join('\n');
  }
  const s = out.scan;
  const lines = [
    `run ${out.run.run_id} (campaign ${out.run.campaign_id}, repo ${out.run.repo_id})`,
    `${s.versions.source.name} ${s.versions.source.version} -> ${s.versions.target.name} ${s.versions.target.version}`,
    `git: ${s.git.is_repo ? `${s.git.head_ref ?? 'detached'} ${s.git.head_commit ?? '(no commit)'}` : 'not a git repo'}, dirty: ${s.git.dirty}`,
    `files read: ${s.files.read} (${s.files.bytes} bytes), skipped: ${s.skipped.length}`,
  ];
  for (const p of s.packages) {
    lines.push(`package ${p.path} (${p.ecosystem}${p.name ? `, ${p.name}` : ''})`);
    for (const e of p.entrypoints) lines.push(`  entrypoint ${e.kind}: ${e.path ?? e.value ?? ''}${e.confidence === 'heuristic' ? ' (heuristic)' : ''}`);
    for (const r of p.tests.runners) lines.push(`  tests: ${r.name}`);
    if (p.tests.test_script) lines.push(`  test script (not run): ${p.tests.test_script}`);
  }
  for (const k of s.skipped) lines.push(`skipped ${k.path}: ${k.reason}`);
  for (const m of s.unrecognised_manifests) lines.push(`unrecognised manifest: ${m}`);
  for (const m of s.manifest_errors) lines.push(`manifest error ${m.path}: ${m.message}`);
  return lines.join('\n');
}
