// Gate 1 (INV-15): every evidence location resolves through SafePath for its
// repo_id, its line range is within the file, and the recomputed snippet_hash
// (the one shared normaliser, M2) matches. Re-checked against the real file on
// every round, so rewriting the finding text cannot satisfy it (failure
// matrix: Gates).
import { snippetHash, sliceLines } from '../../analysis/snippet.js';
import type { GateResult, Plan } from '../../schema/plan.js';
import { PermissionError } from '../../security/errors.js';
import { resolveInside } from '../../security/pathBoundary.js';
import { readText } from '../../security/safeRead.js';
import type { Gate, GateContext } from './index.js';

export const g1Evidence: Gate = {
  id: 'g1_evidence',
  run(plan: Plan, ctx: GateContext): GateResult[] {
    const results: GateResult[] = [];
    for (const finding of plan.findings) {
      for (const [i, e] of finding.evidence.entries()) {
        const where = `${finding.id} evidence[${i}] ${e.file}:${e.line_start}-${e.line_end}`;
        if (e.repo_id !== ctx.repoId) {
          results.push({ gate: 'g1_evidence', subject: finding.id, pass: false, reason: `${where}: evidence repo_id is not the run's repo`, expected: ctx.repoId, actual: e.repo_id });
          continue;
        }
        let text: string;
        try {
          text = readText(resolveInside(ctx.repoRoot, e.file, ctx.repoId));
        } catch (err) {
          const why = err instanceof PermissionError ? err.code : err instanceof Error ? err.message : String(err);
          results.push({ gate: 'g1_evidence', subject: finding.id, pass: false, reason: `${where}: the file could not be read (${why})` });
          continue;
        }
        const lines = text.replace(/\r\n?/g, '\n').split('\n').length;
        if (e.line_end > lines) {
          results.push({ gate: 'g1_evidence', subject: finding.id, pass: false, reason: `${where}: line range runs past the end of the file`, expected: `<= ${lines}`, actual: String(e.line_end) });
          continue;
        }
        const actual = snippetHash(sliceLines(text, e.line_start, e.line_end));
        if (actual !== e.snippet_hash) {
          results.push({ gate: 'g1_evidence', subject: finding.id, pass: false, reason: `${where}: snippet_hash does not match the file`, expected: e.snippet_hash, actual });
          continue;
        }
        results.push({ gate: 'g1_evidence', subject: finding.id, pass: true, reason: `${where}: resolves and the hash matches` });
      }
    }
    return results;
  },
};
