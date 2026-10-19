import { z } from 'zod';
import { Severity } from './knowledge.js';

export const AssessRiskInput = z.object({ run_id: z.string().min(1) }).strict();
export type AssessRiskInput = z.infer<typeof AssessRiskInput>;

export const RiskSignal = z.object({ name: z.string(), detail: z.string() }).strict();

export const UsageRisk = z.object({
  usage_id: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.string(),
  symbol: z.string(),
  rule_id: z.string().nullable(),
  necessity: z.enum(['breaks', 'deprecated']).nullable(),
  unmapped: z.boolean(),
  suggested_severity: Severity,
  signals: z.array(RiskSignal),
});
export type UsageRisk = z.infer<typeof UsageRisk>;

export const AssessRiskOutput = z.object({ run_id: z.string(), risks: z.array(UsageRisk) });
export type AssessRiskOutput = z.infer<typeof AssessRiskOutput>;
