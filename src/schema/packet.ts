// A lens packet: only what that lens needs, size-bounded (M5). Which usage
// kinds arrive is pack data. scan, risks and tests are empty unless this
// lens is the one that uses them (or the packet is combined).
import { z } from 'zod';
import { DocStatus } from './docs.js';
import { FindingLens } from './finding.js';
import { Severity } from './knowledge.js';
import { UsageRisk } from './risk.js';
import { Size } from './scope.js';
import { Usage } from './usage.js';

export const PacketRule = z
  .object({
    id: z.string(),
    library: z.string(),
    title: z.string(),
    event: z.string(),
    necessity: z.enum(['breaks', 'deprecated']),
    lands_on: z.enum(['source', 'target']),
    /** The knowledge rule's concern text. Finding `concern` is a separate enum. */
    summary: z.string(),
    default_severity: Severity,
    codemod: z.string().nullable(),
    mapping: z.object({ from: z.string(), to: z.string() }).strict(),
    verify_hint: z.string(),
    rollback_hint: z.string(),
    doc_topics: z.array(z.string()),
    source: z.string(),
    usage_ids: z.array(z.string()),
  })
  .strict();
export type PacketRule = z.infer<typeof PacketRule>;

export const PacketDoc = z
  .object({
    doc_id: z.string(),
    library: z.string(),
    version: z.string(),
    topic: z.string(),
    url: z.string(),
    status: DocStatus,
  })
  .strict();
export type PacketDoc = z.infer<typeof PacketDoc>;

export const DocQuery = z
  .object({
    library: z.string(),
    version: z.string(),
    symbol: z.string(),
  })
  .strict();
export type DocQuery = z.infer<typeof DocQuery>;

export const PacketCodemod = z
  .object({
    id: z.string(),
    notes: z.string(),
    rule_ids: z.array(z.string()),
    usage_ids: z.array(z.string()),
  })
  .strict();
export type PacketCodemod = z.infer<typeof PacketCodemod>;

export const PacketScan = z
  .object({
    dependencies: z.array(
      z.object({ package: z.string(), name: z.string(), kind: z.string(), declared: z.string().nullable(), resolved: z.string().nullable() }).strict(),
    ),
    tsconfig: z.array(z.object({ package: z.string(), target: z.string().nullable(), module: z.string().nullable(), chain: z.array(z.string()) }).strict()),
    config_files: z.array(z.object({ package: z.string(), kind: z.string(), path: z.string().nullable() }).strict()),
    peer_conflicts: z.array(z.object({ usage_id: z.string(), file: z.string(), symbol: z.string() }).strict()),
  })
  .strict();
export type PacketScan = z.infer<typeof PacketScan>;

export const PacketTests = z
  .object({
    setup: z.array(z.object({ package: z.string(), runners: z.array(z.string()), test_script: z.string().nullable() }).strict()),
    covered: z.array(z.object({ file: z.string(), tests: z.array(z.string()) }).strict()),
    uncovered: z.array(z.string()),
    checks_hint: z.string(),
    verify_hints: z.array(z.object({ rule_id: z.string(), verify_hint: z.string() }).strict()),
  })
  .strict();
export type PacketTests = z.infer<typeof PacketTests>;

export const Truncation = z
  .object({
    usages: z.number().int(),
    rules: z.number().int(),
    symbols: z.number().int(),
    note: z.string().nullable(),
  })
  .strict();
export type Truncation = z.infer<typeof Truncation>;

export const LensPacket = z
  .object({
    run_id: z.string(),
    campaign_id: z.string(),
    repo_id: z.string(),
    lens: FindingLens,
    size: Size,
    prompt_version: z.string(),
    usages: z.array(Usage),
    rules: z.array(PacketRule),
    codemods: z.array(PacketCodemod),
    docs: z.array(PacketDoc),
    symbols: z.array(DocQuery),
    risks: z.array(UsageRisk),
    scan: PacketScan.nullable(),
    tests: PacketTests.nullable(),
    skipped_denied: z.array(z.object({ usage_id: z.string(), code: z.string() }).strict()),
    truncated: Truncation.nullable(),
  })
  .strict();
export type LensPacket = z.infer<typeof LensPacket>;

export const GetLensPacketOutput = z.object({ packet: LensPacket }).strict();
export type GetLensPacketOutput = z.infer<typeof GetLensPacketOutput>;
