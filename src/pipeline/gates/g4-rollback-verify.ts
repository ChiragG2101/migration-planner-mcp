// Gate 4 (INV-18): a finding of severity high or blocker must carry a non-empty
// rollback and verify that are not placeholders. The blocklist rejects "TBD"
// and "n/a" anywhere, and "revert" only when it is the whole string (so "revert
// the next.config change and reinstall 14" is fine, but a bare "revert" is not).
import type { GateResult, Plan } from '../../schema/plan.js';
import type { Gate } from './index.js';

const HIGH = new Set(['high', 'blocker']);
const PHRASES = ['tbd', 'n/a', 'na', 'todo', 'tbc', '?', '-'];

/** True when the text is empty or a placeholder, so it is not a real rollback or verify. */
function placeholder(text: string | undefined): boolean {
  const t = (text ?? '').trim().toLowerCase();
  if (t === '') return true;
  if (t === 'revert') return true;
  return PHRASES.includes(t);
}

export const g4RollbackVerify: Gate = {
  id: 'g4_rollback_verify',
  run(plan: Plan): GateResult[] {
    const results: GateResult[] = [];
    for (const finding of plan.findings) {
      if (!HIGH.has(finding.severity)) {
        results.push({ gate: 'g4_rollback_verify', subject: finding.id, pass: true, reason: `${finding.id} is ${finding.severity}; rollback and verify are not required` });
        continue;
      }
      const bad: string[] = [];
      if (placeholder(finding.rollback)) bad.push('rollback');
      if (placeholder(finding.verify)) bad.push('verify');
      if (bad.length) {
        results.push({ gate: 'g4_rollback_verify', subject: finding.id, pass: false, reason: `${finding.id} is ${finding.severity} and its ${bad.join(' and ')} ${bad.length === 1 ? 'is' : 'are'} missing or a placeholder`, expected: 'a concrete rollback and verify', actual: `rollback=${JSON.stringify(finding.rollback ?? null)}, verify=${JSON.stringify(finding.verify)}` });
      } else {
        results.push({ gate: 'g4_rollback_verify', subject: finding.id, pass: true, reason: `${finding.id} has a rollback and a verify` });
      }
    }
    return results;
  },
};
