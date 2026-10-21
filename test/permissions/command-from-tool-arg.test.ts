// command-from-tool-arg-refused (M8, C9). No tool input schema may carry a
// free-text command/argv/script field that could reach exec.ts. Commands come
// only from the user's frozen check config (D44), never from a tool argument.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tools } from '../../src/tools/index.js';
import { SubmitStagePatchInput, VerifyStageInput } from '../../src/schema/verify.js';

const BANNED = /^(command|argv|cmd|script|shell|exec|run_command|install|check|checks)$/i;

/** Walk a Zod object schema and collect every top-level and nested key name. */
function keyNames(schema: z.ZodTypeAny, depth = 0): string[] {
  if (depth > 6) return [];
  const def = (schema as { _def?: { typeName?: string } })._def;
  const names: string[] = [];
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      names.push(key);
      names.push(...keyNames(child as z.ZodTypeAny, depth + 1));
    }
  } else if (schema instanceof z.ZodArray) {
    names.push(...keyNames(schema.element as z.ZodTypeAny, depth + 1));
  } else if (def?.typeName === 'ZodOptional' || def?.typeName === 'ZodNullable' || def?.typeName === 'ZodDefault') {
    const inner = (schema as unknown as { unwrap?: () => z.ZodTypeAny }).unwrap?.();
    if (inner) names.push(...keyNames(inner, depth + 1));
  } else if (schema instanceof z.ZodUnion) {
    for (const opt of (schema as z.ZodUnion).options as z.ZodTypeAny[]) names.push(...keyNames(opt, depth + 1));
  }
  return names;
}

describe('command-from-tool-arg-refused', () => {
  it('no registered tool input schema exposes a command-like field', () => {
    for (const def of tools) {
      const names = keyNames(def.inputSchema);
      const offenders = names.filter((n) => BANNED.test(n));
      expect(offenders, `tool ${def.name} exposes ${offenders.join(', ')}`).toEqual([]);
    }
  });

  it('verify tool inputs carry only run_id/stage_id/patch, never a command', () => {
    expect(keyNames(VerifyStageInput).sort()).toEqual(['run_id', 'stage_id']);
    const submit = keyNames(SubmitStagePatchInput);
    expect(submit).toContain('patch');
    expect(submit.filter((n) => BANNED.test(n))).toEqual([]);
  });
});
