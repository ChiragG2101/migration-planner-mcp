// INV-15..INV-20 (C7, M6 acceptance, D37): the gates are deterministic and
// import no network, docs-fetch, or model/MCP SDK code. The ESLint override on
// src/pipeline/gates/** enforces it; this test checks the real gate files are
// clean and that the rule fails on planted violations (remove the override and
// these planted cases pass, so the test fails).
import { describe, expect, it } from 'vitest';
import { collectImports, sourceFiles } from '../static.js';
import { lintAs } from '../static.js';
import { repoRoot } from '../helpers.js';
import path from 'node:path';

const GATES_DIR = path.join(repoRoot, 'src', 'pipeline', 'gates');

const FORBIDDEN = [
  /(^|\/)docs\/(context7|cache)(\.js)?$/,
  /(^|\/)security\/network(\.js)?$/,
  /^(@modelcontextprotocol\/|openai$|@anthropic-ai\/|^ai$)/,
];

function forbidden(module: string): boolean {
  return module === 'openai' || module === 'ai' || FORBIDDEN.some((r) => r.test(module));
}

describe('gates import no network or model code', () => {
  it('every file under src/pipeline/gates imports nothing forbidden', () => {
    const offenders = sourceFiles(GATES_DIR)
      .flatMap(collectImports)
      .filter((u) => forbidden(u.module));
    expect(offenders).toEqual([]);
  });

  it('the lint rule fails on planted network, docs and model imports in a gate file', async () => {
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { c } from '../../docs/context7.js';\nc();\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { c } from '../../docs/cache.js';\nc();\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { n } from '../../security/network.js';\nn();\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { Server } from '@modelcontextprotocol/server';\nServer;\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import OpenAI from 'openai';\nOpenAI;\n")).not.toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { generateText } from 'ai';\ngenerateText;\n")).not.toEqual([]);
  });

  it('the lint rule allows a gate to import schema and store code inside src/', async () => {
    expect(await lintAs('src/pipeline/gates/planted.ts', "import type { Plan } from '../../schema/plan.js';\nconst _p: Plan | null = null;\n")).toEqual([]);
    expect(await lintAs('src/pipeline/gates/planted.ts', "import { docRefAccepted } from '../../store/docs.js';\ndocRefAccepted([], { doc_id: 'x', url: 'y' });\n")).toEqual([]);
  });
});
