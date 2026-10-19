// A pack is thin (docs/design.md D10): which libraries it composes, the range
// it has been checked for, its usage adapter, which lens gets each usage kind,
// the staging strategy and the skill trigger. It holds no rules. Unknown keys
// are rejected, so no field can carry a command (C9); `checks_hint` is
// display text, never executed.
import { z } from 'zod';
import { LibraryId } from './knowledge.js';

export const Lens = z.enum(['api', 'dependency_build', 'behavior_runtime', 'verification']);
export type Lens = z.infer<typeof Lens>;

const VersionText = z.string().regex(/^\d+(\.\d+){0,2}$/, 'a plain version such as 14 or 4.2');

export const Pack = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'the semver of the pack content'),
    kind: z.enum(['upgrade', 'swap']),
    language: z.enum(['ts', 'python']),
    trigger: z.string().trim().min(1).max(300).describe('One sentence, starting "Use when"; it becomes the skill description.'),
    libraries: z
      .array(z.object({ id: LibraryId, role: z.enum(['primary', 'companion']) }).strict())
      .min(1)
      .refine((ls) => ls.filter((l) => l.role === 'primary').length === 1, 'exactly one primary library')
      .refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, 'each library once'),
    supported: z.object({ from: VersionText, to: VersionText }).strict().describe("The primary's release units this pack has been checked for."),
    usage_adapter: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('A usage adapter ID from src/analysis/usages/index.ts.'),
    usage_kinds: z.array(z.object({ kind: z.string().min(1), lens: Lens }).strict()).min(1),
    staging: z.enum(['leaf_first', 'config_first']),
    checks_hint: z.string().trim().min(1).max(2000),
    references: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, 'a Markdown file name in references-src/')),
    seeded: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('The seeded repo under eval/seeded/.'),
  })
  .strict()
  .refine((p) => /^Use when /.test(p.trigger), { path: ['trigger'], message: 'the trigger starts with "Use when"' });
export type Pack = z.infer<typeof Pack>;
