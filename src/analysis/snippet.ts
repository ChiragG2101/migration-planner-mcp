// The one snippet normaliser. find_usages, finding normalisation (M5) and
// gate 1 (M6) all hash through here, so they can never disagree. It is
// language-independent: line endings become LF and trailing whitespace goes.
import { createHash } from 'node:crypto';

export function normalizeSnippet(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

export function snippetHash(text: string): string {
  return createHash('sha256').update(normalizeSnippet(text)).digest('hex');
}

/** The 1-based lines `start..end` of a file's text, joined with LF. */
export function sliceLines(text: string, start: number, end: number): string {
  return text.replace(/\r\n?/g, '\n').split('\n').slice(start - 1, end).join('\n');
}
