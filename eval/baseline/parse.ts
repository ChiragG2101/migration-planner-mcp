// The baseline parser (M7 task 4). The baseline is the same host agent on the
// same task but with no engine: it returns a Markdown plan, which this turns
// into best-effort findings (file:line mentions and severities). A citation
// that does not resolve to a real file at base counts as invalid, not skipped
// (plan task 4). Pure: it takes the Markdown and the set of real files, and
// returns parsed findings. No I/O.
import type { BaselineFinding } from '../schema.js';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'blocker'] as const;
type Severity = (typeof SEVERITIES)[number];

/** A list item's leading severity marker: **[high]**, **high**, [high] or bare `high`. */
function severityOf(line: string): Severity | null {
  const m = line.match(/\*{0,2}\[?\b(info|low|medium|high|blocker)\b\]?\*{0,2}/i);
  if (!m) return null;
  const s = m[1]!.toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : null;
}

/**
 * A path and optional line from an inline-code citation: `foo/bar.ts:12`.
 * Only backticked spans are read, so prose that happens to contain a dotted
 * word is not mistaken for a path. The path keeps forward slashes.
 */
function citationOf(line: string): { file: string; line: number | null } | null {
  // Paths may hold Next.js route segments: brackets ([id]), parens ((group)),
  // @slots and dots. Keep forward slashes; require a dotted extension.
  const pathChar = "[\\w./@()\\[\\]-]";
  for (const span of line.matchAll(/`([^`]+)`/g)) {
    const text = span[1]!.trim();
    const m = text.match(new RegExp(`^(${pathChar}+\\.[A-Za-z0-9]+)(?::(\\d+))?$`));
    if (m) return { file: m[1]!, line: m[2] ? Number(m[2]) : null };
  }
  return null;
}

export interface ParsedBaseline {
  findings: BaselineFinding[];
  /** Citations that did not resolve to a real file at base; counted as invalid (not skipped). */
  invalid: { file: string; line: number | null }[];
}

/**
 * Parse a baseline Markdown plan. `realFiles` is the set of repo-relative file
 * paths at the case's base commit. A list item with a citation to a real file
 * becomes a finding; one whose citation does not resolve is recorded as
 * invalid. Items with no citation are ignored (they are prose, not findings).
 */
export function parseBaseline(markdown: string, realFiles: ReadonlySet<string>): ParsedBaseline {
  const findings: BaselineFinding[] = [];
  const invalid: { file: string; line: number | null }[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!/^[-*]\s+/.test(line)) continue;
    const cite = citationOf(line);
    if (!cite) continue;
    if (realFiles.has(cite.file)) {
      findings.push({ file: cite.file, line: cite.line, severity: severityOf(line) });
    } else {
      invalid.push(cite);
    }
  }
  return { findings, invalid };
}
