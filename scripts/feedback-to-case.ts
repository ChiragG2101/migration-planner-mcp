// Feedback to an eval case (M9 task 6). Manual and reviewed: a maintainer
// reads one exported feedback file (<out>/eval/feedback/<run_id>-<n>.json,
// written by record_feedback) and either
//   - appends it to a golden case's annotations.json (--annotate <case>), the
//     file D15 lets grow by appended entries only: existing entries are carried
//     over unchanged and in order, and headline metrics stay on raw truth (INV-30); or
//   - prints a seeded ground-truth entry (--seeded) for the maintainer to place
//     in a seeded repo by hand, after planting the code it points at.
// Outside the engine (INV-40): src/ never imports this. No network.
//
//   npm run feedback:case -- <feedback.json> --annotate <case-id> --reviewer <name> [--date YYYY-MM-DD]
//   npm run feedback:case -- <feedback.json> --seeded
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Annotations, type Annotation } from '../eval/schema.js';
import { FeedbackExport } from '../src/schema/feedback.js';

export type Feedback = ReturnType<typeof FeedbackExport.parse>;

/** One annotation entry for the feedback. A reviewer is required: an annotation is a reviewed claim, never automatic. */
export function toAnnotation(fb: Feedback, reviewer: string, date: string): Annotation {
  if (!reviewer.trim()) throw new Error('an annotation needs --reviewer');
  const finding = fb.finding_id ?? (fb.file ? `${fb.file}${fb.line ? `:${fb.line}` : ''}` : null);
  if (!finding) throw new Error('the feedback names no finding and no file, so there is nothing to annotate');
  return { finding, reason: `${fb.kind}: ${fb.note} (feedback ${fb.run_id}-${fb.n})`, reviewer, date };
}

/**
 * Appends one entry. Existing entries are carried over unchanged and in order;
 * an entry equal to an existing one is refused rather than duplicated.
 */
export function appendAnnotation(existing: Annotation[] | undefined, entry: Annotation): { entries: Annotation[] } {
  const entries = existing ?? [];
  if (entries.some((e) => e.finding === entry.finding && e.reason === entry.reason)) throw new Error(`annotations.json already has this entry for ${entry.finding}`);
  return { entries: [...entries, entry] };
}

/** A seeded ground-truth entry: `missing` is a change the plan missed, `wrong` a finding that should not exist. */
export function toSeededEntry(fb: Feedback): Record<string, unknown> {
  const id = `fb-${fb.run_id}-${fb.n}`;
  if (fb.kind === 'missing') {
    if (!fb.file || !fb.line) throw new Error('a missing entry needs a file and line to become a seeded case');
    return { id, file: fb.file, line: fb.line, kind: '<usage kind>', expect: 'change', indirect: false, note: fb.note };
  }
  if (fb.kind === 'wrong') {
    const e = fb.finding?.evidence[0];
    if (!e) throw new Error('a wrong entry needs a finding with evidence to become a seeded case');
    return { id, file: e.file, line: e.line_start, kind: '<usage kind>', expect: 'no_finding', indirect: false, note: fb.note, ...(fb.finding?.rule_id ? { rule_id: fb.finding.rule_id } : {}) };
  }
  throw new Error(`feedback of kind ${fb.kind} does not map to a seeded case; annotate a golden case or keep it as a note`);
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { annotate: { type: 'string' }, reviewer: { type: 'string' }, date: { type: 'string' }, seeded: { type: 'boolean' } },
  });
  const file = positionals[0];
  if (!file || (!values.annotate && !values.seeded)) throw new Error('usage: feedback-to-case <feedback.json> (--annotate <case-id> --reviewer <name> | --seeded)');
  const fb = FeedbackExport.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (values.seeded) {
    process.stdout.write(`${JSON.stringify(toSeededEntry(fb), null, 2)}\n`);
    return;
  }
  const caseDir = path.join('eval', 'cases', values.annotate!);
  if (!existsSync(path.join(caseDir, 'case.json'))) throw new Error(`no golden case at ${caseDir}`);
  const annPath = path.join(caseDir, 'annotations.json');
  const existing = existsSync(annPath) ? Annotations.parse(JSON.parse(readFileSync(annPath, 'utf8'))).entries : undefined;
  const entry = toAnnotation(fb, values.reviewer ?? '', values.date ?? new Date().toISOString().slice(0, 10));
  writeFileSync(annPath, `${JSON.stringify(appendAnnotation(existing, entry), null, 2)}\n`);
  process.stderr.write(`appended 1 entry to ${annPath}; review the diff before committing\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
