// The one snippet normaliser: CRLF vs LF and trailing whitespace give the
// same hash, a real edit changes it, for TS and Python text alike; and a
// line slice is 1-based and inclusive.
import { describe, expect, it } from 'vitest';
import { normalizeSnippet, sliceLines, snippetHash } from '../../../src/analysis/snippet.js';

const ts = "const store = await cookies();\nconst token = store.get('token');";
const py = 'def view(request):\n    return render(request, "index.html")';

describe.each([
  ['TS', ts],
  ['Python', py],
])('snippet hash (%s)', (_name, text) => {
  it('is the same for LF, CRLF, CR and trailing spaces or tabs', () => {
    const variants = [text, text.replace(/\n/g, '\r\n'), text.replace(/\n/g, '\r'), text.replace(/\n/g, '   \n') + ' \t'];
    expect(new Set(variants.map(snippetHash)).size).toBe(1);
    expect(normalizeSnippet(variants[3]!)).toBe(text);
  });

  it('changes on a real edit, including leading indentation', () => {
    expect(snippetHash(`${text}x`)).not.toBe(snippetHash(text));
    expect(snippetHash(`  ${text}`)).not.toBe(snippetHash(text));
  });
});

describe('line slices', () => {
  it('slices 1-based inclusive line ranges', () => {
    expect(sliceLines('a\r\nb\nc\n', 2, 3)).toBe('b\nc');
  });
});
