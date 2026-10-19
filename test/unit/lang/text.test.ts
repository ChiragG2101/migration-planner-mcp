// The text scanner: literal patterns only, heuristic results, and reads that
// go through the path boundary and the deny list.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFile, scanLines } from '../../../src/lang/text.js';
import { resolveRepoRoot } from '../../../src/security/pathBoundary.js';
import { expectPermission, tmpDir, writeTree } from '../../helpers.js';

describe('text scanner', () => {
  it('finds literal patterns per line, with CRLF input, and labels every hit heuristic', () => {
    const hits = scanLines("@import '~bootstrap/x';\r\nbody {}\r\n  @use \"~a\";\n", [
      { id: 'import', literal: "@import '~" },
      { id: 'use', literal: '@use "~' },
    ]);
    expect(hits).toEqual([
      { pattern: 'import', line: 1, column: 1, text: "@import '~bootstrap/x';", confidence: 'heuristic' },
      { pattern: 'use', line: 3, column: 3, text: '@use "~a";', confidence: 'heuristic' },
    ]);
  });

  it('treats patterns as literals, not regexes', () => {
    expect(scanLines('a.b\naxb\n', [{ id: 'dot', literal: 'a.b' }]).map((h) => h.line)).toEqual([1]);
  });

  it('reads through the boundary: a deny-listed file and a path outside the root are refused', () => {
    const root = path.join(tmpDir(), 'repo');
    writeTree(root, { '.env.example': 'SECRET=1\n', 'styles/a.scss': "@import '~x';\n" });
    const real = resolveRepoRoot(root);
    expect(scanFile(real, 'r', 'styles/a.scss', [{ id: 't', literal: '~' }])).toHaveLength(1);
    expectPermission(() => scanFile(real, 'r', '.env.example', [{ id: 's', literal: 'SECRET' }]), 'denied');
    expectPermission(() => scanFile(real, 'r', '../outside.scss', [{ id: 's', literal: 'x' }]), 'outside_root');
  });
});
