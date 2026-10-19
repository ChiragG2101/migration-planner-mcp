// INV-40 (C3, C6): nothing under src/ imports from scripts/ or eval/. The
// maintainer tools there use the network, and the eval tooling writes files
// and runs git, outside the engine's single write and spawn points.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers.js';
import { allImports, lintAs } from '../static.js';

/** The repo-relative file a relative import resolves to, or null for a package import. */
function target(file: string, module: string): string | null {
  if (!module.startsWith('.')) return null;
  const abs = path.resolve(repoRoot, path.dirname(file), module);
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

const outsideEngine = (rel: string): boolean => /^(scripts|eval)(\/|$)/.test(rel);

describe('engine imports', () => {
  it('no file under src/ imports from scripts/ or eval/', () => {
    const offenders = allImports().filter((u) => {
      if (u.module === '<non-literal>') return true;
      const rel = target(u.file, u.module);
      return rel !== null && (outsideEngine(rel) || rel.startsWith('..'));
    });
    expect(offenders).toEqual([]);
  });

  it('the static check resolves a planted import exactly', () => {
    expect(outsideEngine(target('src/core/x.ts', '../../scripts/build-pack.js')!)).toBe(true);
    expect(outsideEngine(target('src/rules/x.ts', '../../eval/seeded/recall.js')!)).toBe(true);
    expect(outsideEngine(target('src/core/x.ts', '../rules/loader.js')!)).toBe(false);
  });

  it('the lint rule fails on planted imports from scripts/ and eval/', async () => {
    expect(await lintAs('src/core/planted.ts', "import { x } from '../../scripts/lint-packs.js';\nx();\n")).not.toEqual([]);
    expect(await lintAs('src/rules/planted.ts', "import { y } from '../../eval/seeded/recall.js';\ny();\n")).not.toEqual([]);
    expect(await lintAs('src/analysis/usages/planted.ts', "export * from '../../../scripts/draft-release.js';\n")).not.toEqual([]);
    expect(await lintAs('src/security/planted.ts', "import { z } from '../../scripts/pack-docs-report.js';\nz();\n")).not.toEqual([]);
    expect(await lintAs('src/security/exec.ts', "import { z } from '../../eval/runner.js';\nz();\n")).not.toEqual([]);
  });

  it('the lint rule allows imports inside src/', async () => {
    expect(await lintAs('src/core/planted.ts', "import { x } from '../rules/loader.js';\nx();\n")).toEqual([]);
  });
});
