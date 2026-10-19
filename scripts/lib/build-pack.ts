// Generates a pack's SKILL.md and references from pack.json, references-src
// and the reviewed knowledge. Generated files are never edited by hand.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFile, type Library, type ReviewedRule } from '../../src/schema/knowledge.js';
import { Pack } from '../../src/schema/pack.js';
import { compareReleaseUnits, parseVersion } from '../../src/rules/versions.js';

export const banner = (version: string): string => `<!-- do not edit; generated from pack v${version} -->`;

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The prompt version the skill and `prompts/plan_migration.vN.md` both name. */
export function currentPromptVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'prompts', 'manifest.json'), 'utf8')) as { current?: string };
  if (!manifest.current) throw new Error('prompts/manifest.json has no current version');
  return manifest.current;
}

function toolOrder(version: string): string[] {
  return [
    '`scan_repo`',
    '`find_usages`',
    '`get_rule_pack`',
    '`assess_risk`',
    '`propose_scope`',
    'ask the user, then `set_scope`',
    `\`plan_migration\` (${version}) for each lens, which registers its docs with \`get_migration_docs\``,
    '`merge_findings`',
    '`validate_plan`',
    '`emit_plan`',
    'at level 1 only, `verify_stage`',
  ];
}

interface LibRules {
  library: Library;
  rules: { release: string; rule: ReviewedRule }[];
}

function readLib(root: string, id: string): LibRules {
  const dir = path.join(root, 'knowledge', ...id.split('/'));
  const library = JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')) as Library;
  const releasesDir = path.join(dir, 'releases');
  const rules: LibRules['rules'] = [];
  if (existsSync(releasesDir)) {
    for (const name of readdirSync(releasesDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = ReleaseFile.parse(JSON.parse(readFileSync(path.join(releasesDir, name), 'utf8')));
      for (const rule of file.rules) if (rule.status === 'reviewed') rules.push({ release: file.release, rule });
    }
  }
  return { library, rules };
}

function releaseUnits(pack: Pack, library: Library): string[] {
  if (library.release_unit === 'major') {
    const from = parseVersion(library.version_scheme, pack.supported.from).release[0]!;
    const to = parseVersion(library.version_scheme, pack.supported.to).release[0]!;
    return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  }
  const have = new Set<string>();
  return [...have];
}

/** The files a pack generates, keyed by path relative to the pack directory. */
export function generatedPack(root: string, packName: string): Record<string, string> {
  const dir = path.join(root, 'packs', packName);
  const pack = Pack.parse(JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8')));
  const primaryId = pack.libraries.find((l) => l.role === 'primary')!.id;
  const primary = readLib(root, primaryId);
  const companions = pack.libraries.filter((l) => l.role === 'companion').map((l) => readLib(root, l.id));
  const head = banner(pack.version);
  const out: Record<string, string> = {};

  const units = releaseUnits(pack, primary.library);
  const links: string[] = [];
  for (const unit of units) {
    const rules = primary.rules.filter((r) => r.release === unit).sort((a, b) => (a.rule.id < b.rule.id ? -1 : 1));
    const body = rules.length
      ? rules.map((r) => `- \`${r.rule.id}\` (${r.rule.event}): ${r.rule.title}`).join('\n')
      : '_No reviewed rules for this release._';
    out[`references/${unit}.md`] = `${head}\n\n# ${pack.name} ${unit}\n\n${body}\n`;
    links.push(`- [${unit}](references/${unit}.md)`);
  }
  for (const comp of companions) {
    const name = comp.library.id.split('/')[1]!;
    const rules = comp.rules
      .filter((r) => compareReleaseUnits(parseVersion(comp.library.version_scheme, r.release), parseVersion(comp.library.version_scheme, comp.library.covered_from), comp.library.release_unit) >= 0)
      .sort((a, b) => (a.rule.id < b.rule.id ? -1 : 1));
    const body = rules.length ? rules.map((r) => `- \`${r.rule.id}\` (${r.release}, ${r.rule.event}): ${r.rule.title}`).join('\n') : '_No reviewed rules._';
    out[`references/${name}-changes.md`] = `${head}\n\n# ${name} changes\n\n${body}\n`;
    links.push(`- [${name} changes](references/${name}-changes.md)`);
  }
  const codemodRules = [...primary.rules, ...companions.flatMap((c) => c.rules)].filter((r) => r.rule.codemod);
  const byCodemod = new Map<string, string[]>();
  for (const lib of [primary, ...companions]) for (const c of lib.library.codemods) byCodemod.set(c.id, []);
  for (const r of codemodRules) byCodemod.get(r.rule.codemod!)?.push(r.rule.id);
  const codemodBody = [...byCodemod.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, ids]) => `- \`${id}\`: ${ids.length ? ids.sort().join(', ') : 'no reviewed rule names it'}`)
    .join('\n');
  out['references/codemods.md'] = `${head}\n\n# Codemods\n\n${codemodBody || '_None._'}\n`;
  links.push('- [codemods](references/codemods.md)');

  const srcDir = path.join(dir, 'references-src');
  if (existsSync(srcDir)) {
    for (const name of readdirSync(srcDir).filter((n) => n.endsWith('.md')).sort()) {
      out[`references/${name}`] = `${head}\n\n${readFileSync(path.join(srcDir, name), 'utf8').trim()}\n`;
      links.push(`- [${name.replace(/\.md$/, '')}](references/${name})`);
    }
  }

  // Frontmatter is first, so a host reads the trigger. The banner follows it.
  const skill = [
    '---',
    `name: ${pack.name}`,
    `description: ${pack.trigger}`,
    '---',
    '',
    head,
    '',
    `# ${pack.name}`,
    '',
    'Plan the migration with the engine, in this order. The engine is read-only at level 0.',
    '',
    ...toolOrder(currentPromptVersion()).map((step, i) => `${i + 1}. ${step}`),
    '',
    'A finding follows the finding schema. Do not inline API tables; read the references.',
    '',
    `Checked range: ${pack.supported.from} to ${pack.supported.to}. Staging: ${pack.staging}.`,
    '',
    ...links,
    '',
  ].join('\n');
  out['SKILL.md'] = skill;
  return out;
}
