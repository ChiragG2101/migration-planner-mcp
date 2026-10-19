// submit_findings. Invalid output is returned with the Zod errors and may be
// retried once; the second invalid submission records lens.gap and a third
// attempt is refused (D16). Evidence is re-read through SafePath and re-hashed
// with the shared normaliser. A mismatch is flagged, not rejected; gate 1
// checks it again (M6).
import { z } from 'zod';
import { snippetHash, sliceLines } from '../analysis/snippet.js';
import { docsUnverifiedBadge } from '../docs/format.js';
import { composeRun, openRunPack } from './packRun.js';
import { runTool, type Engine } from './engine.js';
import {
  SubmitFindingsInput,
  SubmitFindingsOutput,
  parseFinding,
  type EvidenceFlag,
  type FieldError,
  type Finding,
  type SubmitFindingsOutput as SubmitResult,
} from '../schema/finding.js';
import type { DocsStatus } from '../schema/finding.js';
import { InputError, PermissionError } from '../security/errors.js';
import { resolveInside } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';
import { repoRoot } from '../store/campaigns.js';
import { listRunDocs, type RunDocRow } from '../store/docs.js';
import { findingIds, lensState, listFindings, packetUsageIds, putLensState, storeSubmission } from '../store/findings.js';
import { getScope } from '../store/scope.js';
import { loadPrompt } from '../security/promptFile.js';

const ROUND = 1;

function docsStatus(finding: Finding, docs: readonly RunDocRow[]): DocsStatus {
  const cited = finding.doc_refs.map((ref) => {
    const row = docs.find((d) => d.doc_id === ref.doc_id && d.url === ref.url);
    return { status: row?.status ?? ('unverified' as const) };
  });
  return docsUnverifiedBadge(cited) ? 'unverified' : 'verified';
}

function normalise(finding: Finding, root: string, repoId: string, docs: readonly RunDocRow[]): { finding: Finding; flags: EvidenceFlag[] } {
  const flags: EvidenceFlag[] = [];
  for (const evidence of finding.evidence) {
    let match: boolean;
    try {
      const text = readText(resolveInside(root, evidence.file, repoId));
      match = snippetHash(sliceLines(text, evidence.line_start, evidence.line_end)) === evidence.snippet_hash;
    } catch (err) {
      if (err instanceof PermissionError) throw err;
      match = false;
    }
    flags.push({ finding_id: finding.id, file: evidence.file, line_start: evidence.line_start, line_end: evidence.line_end, match });
  }
  return { finding: { ...finding, docs_status: docsStatus(finding, docs) }, flags };
}

function rejected(runId: string, lens: SubmitResult['lens'], errors: FieldError[], gap: boolean): SubmitResult {
  return SubmitFindingsOutput.parse({
    run_id: runId,
    lens,
    accepted: false,
    retry: !gap,
    gap,
    errors,
    stored: 0,
    out_of_scope: 0,
    evidence_flags: [],
  });
}

export async function submitFindings(engine: Engine, raw: unknown): Promise<SubmitResult> {
  const parsed = SubmitFindingsInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  const { lens } = parsed.data;
  return runTool(engine, opened.session, 'submit_findings', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const db = opened.session.db;
    const state = lensState(db, opened.run.id, lens);
    if (state.gap || state.accepted) throw new InputError('lens_closed', 'this lens is closed after a gap or an accepted submission');
    const allowed = packetUsageIds(db, opened.run.id, lens);
    if (!allowed) throw new InputError('no_packet', `fetch the ${lens} packet before submitting findings`);
    const allowedSet = new Set(allowed);
    const scope = getScope(db, opened.run.id);
    const stop = scope?.answers['stop_at'];
    const composed = composeRun(opened.pack, opened.versions, { ...(typeof stop === 'string' ? { stopAt: stop } : {}) });
    const rules = composed.libraries.flatMap((l) => l.rules);
    const codemodsFor = (ruleId: string): readonly string[] | undefined => {
      const rule = rules.find((r) => r.rule.id === ruleId);
      if (!rule) return undefined;
      return opened.pack.libs.get(rule.library)?.library.codemods.map((c) => c.id) ?? [];
    };
    const prompt = loadPrompt();
    const errors: FieldError[] = [];
    const findings: Finding[] = [];
    const seen = new Set<string>(findingIds(db, opened.run.id));
    parsed.data.findings.forEach((rawFinding, i) => {
      const result = parseFinding(rawFinding, { repoId: opened.run.repo_id, codemodsFor });
      if (!result.ok) {
        for (const err of result.errors) errors.push({ path: `findings.${i}.${err.path}`, message: err.message });
        return;
      }
      const finding = result.finding;
      if (finding.lens !== lens) errors.push({ path: `findings.${i}.lens`, message: `lens is ${finding.lens}; this submission is ${lens}` });
      if (finding.prompt_version !== prompt.version) {
        errors.push({ path: `findings.${i}.prompt_version`, message: `prompt_version must be ${prompt.version}` });
      }
      if (seen.has(finding.id)) errors.push({ path: `findings.${i}.id`, message: `finding id ${finding.id} is already used` });
      seen.add(finding.id);
      if (finding.source !== 'agent_judgment' && finding.usage_ids.length === 0) {
        errors.push({ path: `findings.${i}.usage_ids`, message: 'a finding names a usage, unless its source is agent_judgment and it has evidence' });
      }
      for (const id of finding.usage_ids) {
        if (!allowedSet.has(id)) errors.push({ path: `findings.${i}.usage_ids`, message: `usage ${id} is not in this lens packet` });
      }
      findings.push(finding);
    });
    const covered = new Set(findings.flatMap((f) => f.usage_ids));
    const marks: { usage_id: string; reason: string }[] = [];
    const marked = new Set<string>();
    parsed.data.out_of_scope.forEach((entry, i) => {
      if (entry.reason.trim() === '') errors.push({ path: `out_of_scope.${i}.reason`, message: 'reason is empty' });
      if (!allowedSet.has(entry.usage_id)) {
        errors.push({ path: `out_of_scope.${i}.usage_id`, message: `usage ${entry.usage_id} is not in this lens packet` });
      }
      if (covered.has(entry.usage_id)) {
        errors.push({
          path: `out_of_scope.${i}.usage_id`,
          message: `usage ${entry.usage_id} is both marked out of scope and covered by a finding`,
        });
      }
      if (marked.has(entry.usage_id)) {
        errors.push({ path: `out_of_scope.${i}.usage_id`, message: `usage ${entry.usage_id} is marked out of scope more than once` });
        return;
      }
      marked.add(entry.usage_id);
      marks.push({ usage_id: entry.usage_id, reason: entry.reason.trim() });
    });
    if (errors.length) {
      const next = { invalid: state.invalid + 1, gap: state.invalid + 1 >= 2, accepted: false };
      putLensState(db, opened.run.id, lens, next);
      call.event('lens.invalid', { lens, attempt: next.invalid, errors });
      if (next.gap) call.event('lens.gap', { lens, attempts: next.invalid });
      return rejected(opened.run.id, lens, errors, next.gap);
    }
    const root = repoRoot(db, opened.run.repo_id, opened.run.campaign_id);
    if (!root) throw new InputError('unknown_run', `run ${opened.run.id} has no repo`);
    const docs = listRunDocs(db, opened.run.id);
    const flags: EvidenceFlag[] = [];
    const stored: Finding[] = [];
    for (const finding of findings) {
      const norm = normalise(finding, root, opened.run.repo_id, docs);
      stored.push(norm.finding);
      flags.push(...norm.flags);
    }
    const written = marks.map((m) => ({ ...m, written_by: lens }));
    call.event('findings.submitted', { lens, findings, out_of_scope: parsed.data.out_of_scope });
    storeSubmission(db, opened.run.id, lens, stored, written, ROUND);
    putLensState(db, opened.run.id, lens, { invalid: state.invalid, gap: false, accepted: true });
    call.event('findings.normalised', { lens, findings: stored, evidence_flags: flags });
    return SubmitFindingsOutput.parse({
      run_id: opened.run.id,
      lens,
      accepted: true,
      retry: false,
      gap: false,
      errors: [],
      stored: stored.length,
      out_of_scope: written.length,
      evidence_flags: flags,
    });
  });
}

export function findingsForRun(engine: Engine, runId: string): ReturnType<typeof listFindings> {
  const opened = openRunPack(engine, runId);
  return listFindings(opened.session.db, opened.run.id);
}
