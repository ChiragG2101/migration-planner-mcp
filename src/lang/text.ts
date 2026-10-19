// A line-based scanner for files no language adapter owns (templates, styles,
// config fallbacks). Packs drive it with literal patterns; there are no
// regexes from data. Results are always heuristic. Reads go through safeRead,
// so a deny-listed file (such as .env.example) is never opened.
import { resolveInside } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';

export interface TextPattern {
  id: string;
  /** Matched literally, case-sensitive. */
  literal: string;
}

export interface TextHit {
  pattern: string;
  line: number;
  column: number;
  text: string;
  confidence: 'heuristic';
}

/** Every line of `text` that contains one of the literals, in line order. */
export function scanLines(text: string, patterns: readonly TextPattern[]): TextHit[] {
  const hits: TextHit[] = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      for (const p of patterns) {
        const column = line.indexOf(p.literal);
        if (column >= 0) hits.push({ pattern: p.id, line: i + 1, column: column + 1, text: line.trim(), confidence: 'heuristic' });
      }
    });
  return hits;
}

/** Scans one repo file. The path goes through the boundary and the deny list like any read. */
export function scanFile(root: string, repoId: string, rel: string, patterns: readonly TextPattern[]): TextHit[] {
  return scanLines(readText(resolveInside(root, rel, repoId)), patterns);
}
