// The one snippet normaliser: CRLF vs LF and trailing whitespace give the
// same hash, a real edit changes it, for TS and Python text alike; and a
// usage's snippet_hash is stable when its file is rewritten with CRLF.
import { describe, expect, it } from 'vitest';
import { normalizeSnippet, sliceLines, snippetHash } from '../../../src/analysis/snippet.js';
import { buildNext, ofKind } from '../../usages.js';

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

describe('usage snippet hashes', () => {
  it('slices 1-based inclusive line ranges', () => {
    expect(sliceLines('a\r\nb\nc\n', 2, 3)).toBe('b\nc');
  });

  it('a usage keeps its snippet_hash when the file is rewritten with CRLF and trailing spaces', async () => {
    const page = "import { cookies } from 'next/headers';\nexport default async function Page() {\n  const c = await cookies();\n  return c.get('a');\n}\n";
    const lf = ofKind((await buildNext({ 'app/page.tsx': page })).usages, 'request_api');
    const crlf = ofKind((await buildNext({ 'app/page.tsx': page.replace(/\n/g, '  \r\n') })).usages, 'request_api');
    expect(lf).toHaveLength(1);
    expect(crlf[0]!.snippet_hash).toBe(lf[0]!.snippet_hash);
    expect(crlf[0]!.line_start).toBe(lf[0]!.line_start);
  });
});
