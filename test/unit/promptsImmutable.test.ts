// Prompt v1 is immutable, and the skill names the same version and tool order.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentPromptVersion, generatedPack } from '../../scripts/lib/build-pack.js';
import { loadPrompt, sha256Text } from '../../src/security/promptFile.js';
import { repoRoot } from '../helpers.js';

const TOOLS = [
  'scan_repo',
  'find_usages',
  'get_rule_pack',
  'assess_risk',
  'propose_scope',
  'set_scope',
  'plan_migration',
  'get_migration_docs',
  'merge_findings',
  'validate_plan',
  'emit_plan',
  'verify_stage',
];

function toolOrder(text: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const name of [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!)) {
    if (!TOOLS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

describe('plan_migration prompt', () => {
  it('matches the hash recorded in the manifest, so editing v1 fails', () => {
    const body = readFileSync(path.join(repoRoot, 'prompts/plan_migration.v1.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'prompts/manifest.json'), 'utf8')) as {
      current: string;
      prompts: Record<string, string>;
    };
    expect(manifest.current).toBe('v1');
    expect(sha256Text(body)).toBe(manifest.prompts.v1);
    expect(loadPrompt()).toMatchObject({ version: 'v1', hash: manifest.prompts.v1 });
  });

  it('names the same tool order and prompt version as the generated skill', () => {
    const version = currentPromptVersion();
    const prompt = loadPrompt().body;
    const text = generatedPack(repoRoot, 'nextjs-upgrade')['SKILL.md']!;
    expect(toolOrder(prompt)).toEqual(TOOLS);
    expect(toolOrder(text)).toEqual(TOOLS);
    expect(prompt).toContain(`\`plan_migration\` (${version})`);
    expect(text).toContain(`\`plan_migration\` (${version})`);
  });

  it('does not tell the agent to edit files or run commands', () => {
    const body = loadPrompt().body;
    expect(body).not.toMatch(/\bedit the (file|repo|code)\b/i);
    expect(body).not.toMatch(/\b(run|execute) (npm|yarn|pnpm|the command|a command)\b/i);
  });
});
