// get_lens_packet. The first packet freezes scope by writing packet.fetched,
// which set_scope already refuses on (D12).
import { z } from 'zod';
import { newCuts } from '../pipeline/budget.js';
import { buildLensPacket } from '../pipeline/packets.js';
import { SEPARATE_LENSES } from '../schema/finding.js';
import { GetLensPacketOutput } from '../schema/packet.js';
import { GetLensPacketInput } from '../schema/plan.js';
import { ScanResult } from '../schema/scan.js';
import type { Size } from '../schema/scope.js';
import { InputError } from '../security/errors.js';
import { repoRoot } from '../store/campaigns.js';
import { listRunDocs } from '../store/docs.js';
import { listEvents } from '../store/events.js';
import { putPacketUsages } from '../store/findings.js';
import { getScope } from '../store/scope.js';
import { loadPrompt } from '../security/promptFile.js';
import { runTool, type Engine } from './engine.js';
import { composeRun, openRunPack, requireUsages } from './packRun.js';

export async function getLensPacket(engine: Engine, raw: unknown): Promise<GetLensPacketOutput> {
  const parsed = GetLensPacketInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  const opened = openRunPack(engine, parsed.data.run_id);
  return runTool(engine, opened.session, 'get_lens_packet', parsed.data, (call) => {
    call.attachRun(opened.run.id);
    const events = listEvents(opened.session.db, opened.run.id);
    const set = events.findLast((e) => e.kind === 'scope.set');
    if (!set) throw new InputError('no_scope', 'call set_scope before fetching a lens packet');
    const size = (JSON.parse(set.payload_json) as { size: Size }).size;
    const lens = parsed.data.lens;
    if (size === 'none') throw new InputError('lens_refused', 'a none run has no lenses');
    if (lens === 'combined' && size !== 'small') throw new InputError('lens_refused', 'combined is only for a small run');
    if (lens !== 'combined' && size === 'small') throw new InputError('lens_refused', 'a small run uses the combined lens');
    // Over budget: every lens not fetched yet is cut (recorded once each) and no new packet is given (M9 task 5).
    const fetched = new Set(events.filter((e) => e.kind === 'packet.fetched').map((e) => (JSON.parse(e.payload_json) as { lens: string }).lens));
    const lenses: readonly string[] = size === 'small' ? ['combined'] : SEPARATE_LENSES;
    const over = newCuts(engine.options.budget, events, engine.now(), lenses.filter((l) => !fetched.has(l)).map((id) => ({ what: 'lens' as const, id })));
    if (over.reason) {
      for (const cut of over.cuts) call.event('budget.cut', cut);
      throw new InputError('budget_cut', `the run is over budget (${over.reason}); lenses not fetched yet are recorded as budget_cut and their usages stay uncovered`);
    }
    const scanEvent = events.findLast((e) => e.kind === 'scan.result');
    if (!scanEvent) throw new InputError('no_scan', `run ${opened.run.id} has no scan; call scan_repo first`);
    const scan = ScanResult.parse(JSON.parse(scanEvent.payload_json));
    const loaded = requireUsages(opened.session, opened.run.id);
    const scope = getScope(opened.session.db, opened.run.id);
    const stop = scope?.answers['stop_at'];
    const composed = composeRun(opened.pack, opened.versions, {
      ...(typeof stop === 'string' ? { stopAt: stop } : {}),
      usages: loaded.usages,
    });
    const root = repoRoot(opened.session.db, opened.run.repo_id, opened.run.campaign_id);
    if (!root) throw new InputError('unknown_run', `run ${opened.run.id} has no repo`);
    const prompt = loadPrompt();
    const packet = buildLensPacket({
      lens,
      size,
      promptVersion: prompt.version,
      runId: opened.run.id,
      campaignId: opened.run.campaign_id,
      repoId: opened.run.repo_id,
      repoRoot: root,
      pack: opened.pack.pack,
      libs: opened.pack.libs,
      composed,
      usages: loaded.usages,
      excluded: new Set((scope?.out_of_scope ?? []).map((o) => o.usage_id)),
      imports: loaded.imports,
      scan,
      docs: listRunDocs(opened.session.db, opened.run.id),
      maxChars: engine.packetMaxChars,
    });
    putPacketUsages(opened.session.db, opened.run.id, lens, packet.usages.map((u) => u.id));
    call.event('packet.fetched', { lens, usages: packet.usages.length, truncated: packet.truncated !== null });
    return GetLensPacketOutput.parse({ packet });
  });
}
