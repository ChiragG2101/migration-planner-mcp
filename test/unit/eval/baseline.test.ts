// Baseline parser tests (M7 Tests: baseline parser).
import { describe, expect, it } from 'vitest';
import { parseBaseline } from '../../../eval/baseline/parse.js';

const realFiles = new Set(['app/page.tsx', 'package.json', 'lib/db.ts']);

describe('parseBaseline', () => {
  it('extracts file:line and severity from Markdown list items', () => {
    const md = [
      '# Plan',
      '- **[high]** `app/page.tsx:12` — await cookies().',
      '- **[low]** `package.json:3` — bump next.',
      'Some prose that is not a finding.',
    ].join('\n');
    const r = parseBaseline(md, realFiles);
    expect(r.findings).toEqual([
      { file: 'app/page.tsx', line: 12, severity: 'high' },
      { file: 'package.json', line: 3, severity: 'low' },
    ]);
    expect(r.invalid).toEqual([]);
  });

  it('counts an unresolvable citation as invalid, not skipped', () => {
    const md = '- **[high]** `app/ghost.tsx:1` — change something.';
    const r = parseBaseline(md, realFiles);
    expect(r.findings).toEqual([]);
    expect(r.invalid).toEqual([{ file: 'app/ghost.tsx', line: 1 }]);
  });

  it('reads a finding with no line and no severity', () => {
    const md = '- `lib/db.ts` — review the data layer.';
    const r = parseBaseline(md, realFiles);
    expect(r.findings).toEqual([{ file: 'lib/db.ts', line: null, severity: null }]);
  });

  it('ignores list items with no citation', () => {
    const md = '- A general note about the upgrade.';
    expect(parseBaseline(md, realFiles).findings).toEqual([]);
  });
});
