// The composed rules for a range, with necessity and lands_on derived.
import { z } from 'zod';
import { composePack, type PackComposition } from '../rules/compose.js';
import { packForLibrary, type PackBundle } from '../rules/loader.js';
import { bindsTo } from '../rules/match.js';
import { parseVersion, releaseUnitOf } from '../rules/versions.js';
import { GetRulePackInput, type GetRulePackOutput } from '../schema/rulePack.js';
import type { Usage } from '../schema/usage.js';
import { InputError, NotBuiltError } from '../security/errors.js';
import { runTool, type Engine } from './engine.js';
import { referenceUri } from './packReferences.js';
import { allUsages, composeRun, noPack, openRunPack } from './packRun.js';

export async function getRulePack(engine: Engine, raw: unknown): Promise<GetRulePackOutput> {
  const parsed = GetRulePackInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const input = parsed.data;
  if (input.run_id && (input.source || input.target)) {
    throw new InputError('invalid_input', 'give a run_id, or a source and a target, not both');
  }
  if (input.run_id) {
    const opened = openRunPack(engine, input.run_id);
    return runTool(engine, opened.session, 'get_rule_pack', input, (call) => {
      call.attachRun(input.run_id!);
      const usages = input.present_only ? allUsages(opened.session, input.run_id!) : undefined;
      const out = packOutput(opened.pack, composeRun(opened.pack, opened.versions, usages ? { usages } : {}), usages);
      call.event('rule_pack.result', { pack: out.pack, rules: out.rules.length });
      return out;
    });
  }
  if (!input.source || !input.target) throw new InputError('invalid_input', 'give a run_id, or both a source and a target');
  if (input.present_only) throw new InputError('present_only', 'present_only needs a run_id, so the usages are known');
  const pack = packForLibrary(engine.bundle, input.source.name, 'node');
  if (!pack) throw new NotBuiltError(noPack(input.source.name));
  const primary = pack.pack.libraries.find((l) => l.role === 'primary')!.id;
  const composed = composePack(pack.pack, pack.libs, { installed: { [primary]: input.source.version }, target: input.target.version });
  return packOutput(pack, composed);
}

function packOutput(pack: PackBundle, composed: PackComposition, usages?: readonly Usage[]): GetRulePackOutput {
  let rules = composed.libraries.flatMap((l) => l.rules);
  if (usages) rules = rules.filter((r) => usages.some((u) => u.match_kind !== null && bindsTo(r.rule.match, u)));
  const codemods = new Map<string, string[]>();
  for (const lib of pack.libs.values()) for (const c of lib.library.codemods) codemods.set(c.id, []);
  for (const r of rules) if (r.rule.codemod && codemods.has(r.rule.codemod)) codemods.get(r.rule.codemod)!.push(r.rule.id);
  const scheme = pack.primary.library.version_scheme;
  const unit = pack.primary.library.release_unit;
  const from = releaseUnitOf(parseVersion(scheme, pack.pack.supported.from), unit).release[0]!;
  const to = releaseUnitOf(parseVersion(scheme, pack.pack.supported.to), unit).release[0]!;
  const ref = (file: string): string => referenceUri(pack.pack.name, file);
  const references = [
    ...(unit === 'major' ? Array.from({ length: to - from + 1 }, (_, i) => ref(`${from + i}.md`)) : []),
    ...pack.pack.libraries.filter((l) => l.role === 'companion').map((l) => ref(`${l.id.split('/')[1]}-changes.md`)),
    ref('codemods.md'),
  ];
  return {
    pack: pack.ref,
    supported: pack.pack.supported,
    rules: rules.map((r) => ({
      id: r.rule.id,
      library: r.library,
      title: r.rule.title,
      event: r.rule.event,
      necessity: r.necessity,
      lands_on: r.lands_on,
      default_severity: r.rule.default_severity,
      codemod: r.rule.codemod ?? null,
      source: r.rule.source,
    })),
    codemods: [...codemods.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, ids]) => ({ id, rules: ids.sort() })),
    notes: composed.notes.map((n) => n.message),
    references,
  };
}
