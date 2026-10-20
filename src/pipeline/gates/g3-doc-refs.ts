// Gate 3 (INV-17): every doc_refs entry's doc_id exists in run_docs for THIS
// run, and its URL matches the stored URL. It is a lookup, not a string match,
// because the finding carries a doc_id (M5). The same citation check
// get_migration_docs defines (docRefAccepted) is reused, so the gate and the
// docs tool never disagree.
import type { GateResult, Plan } from '../../schema/plan.js';
import { docRefAccepted } from '../../store/docs.js';
import type { Gate, GateContext } from './index.js';

export const g3DocRefs: Gate = {
  id: 'g3_doc_refs',
  run(plan: Plan, ctx: GateContext): GateResult[] {
    const results: GateResult[] = [];
    const docs = ctx.docs.map((d) => ({ doc_id: d.doc_id, url: d.url }));
    for (const finding of plan.findings) {
      for (const [i, ref] of finding.doc_refs.entries()) {
        if (docRefAccepted(docs, ref)) {
          results.push({ gate: 'g3_doc_refs', subject: finding.id, pass: true, reason: `${finding.id} doc_refs[${i}] ${ref.doc_id} was registered in this run` });
        } else {
          const stored = ctx.docs.find((d) => d.doc_id === ref.doc_id);
          const reason = !stored
            ? `${finding.id} doc_refs[${i}]: doc_id ${ref.doc_id} was not registered in this run`
            : `${finding.id} doc_refs[${i}]: the URL does not match the registered doc`;
          const extra = stored ? { expected: stored.url, actual: ref.url } : {};
          results.push({ gate: 'g3_doc_refs', subject: finding.id, pass: false, reason, ...extra });
        }
      }
    }
    return results;
  },
};
