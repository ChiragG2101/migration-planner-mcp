import { getLensPacket, GetLensPacketInput } from '../core/index.js';
import { GetLensPacketOutput } from '../schema/packet.js';
import type { ToolDef } from './index.js';

export const getLensPacketTool: ToolDef = {
  name: 'get_lens_packet',
  title: 'Get a lens packet',
  description:
    'The evidence for one lens. A full run has api, dependency_build, behavior_runtime and verification; a small run has combined; a none run has none. ' +
    'The first packet freezes the scope. The packet does not include other lenses\' findings. Read-only.',
  inputSchema: GetLensPacketInput,
  outputSchema: GetLensPacketOutput,
  handler: (engine, input) => getLensPacket(engine, input),
};
