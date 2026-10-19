// The typed rule matches. A rule's `match` is one of these kinds, each with
// its own fields, so knowledge says what to look for without any code. The
// set covers both v0.1 packs (Next.js and Django); a new kind is a core change.
// How each kind lines up with a usage is in src/rules/match.ts (D30).
import { z } from 'zod';

export const MatchKind = z.enum([
  'import',
  'call',
  'attribute',
  'config_key',
  'setting',
  'string_ref',
  'template_tag',
  'template_filter',
  'dependency',
  'file_convention',
]);
export type MatchKind = z.infer<typeof MatchKind>;

/** A module or package specifier: `next/headers`, `@next/font`, `django.conf.urls`. */
const Module = z.string().regex(/^@?[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/, 'a module or package name');
/** One identifier. */
const Name = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'an identifier');
/** Identifiers joined by dots: `NextRequest.geo`, `experimental.ppr`. */
const DottedPath = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z_$][A-Za-z0-9_$-]*)*$/, 'identifiers joined by dots');
/** A version range in the library's scheme; `*` for any version. Checked against the scheme when loaded. */
const Range = z.string().min(1).max(200);
/** A glob over repo-relative paths (`**`, `*`, `{a,b}`); no `..` and no leading `/`. */
const Glob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.*{},@[\]()\-/]+$/, 'a glob of path characters')
  .refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), 'a glob relative to the repo, without ..');

/** The files whose keys a `config_key` match reads. `segment` is a Next.js route segment config export. */
export const ConfigFileKind = z.enum(['next.config', 'segment', 'tsconfig']);

export const Match = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('import'), module: Module, name: Name.optional() }).strict(),
  z.object({ kind: z.literal('call'), module: Module.nullable().describe('null for a global such as fetch'), name: Name }).strict(),
  z.object({ kind: z.literal('attribute'), module: Module, path: DottedPath }).strict(),
  z.object({ kind: z.literal('config_key'), file_kind: ConfigFileKind, path: DottedPath }).strict(),
  z.object({ kind: z.literal('setting'), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'a settings name') }).strict(),
  z.object({ kind: z.literal('string_ref'), dotted_path: DottedPath }).strict(),
  z.object({ kind: z.literal('template_tag'), name: Name }).strict(),
  z.object({ kind: z.literal('template_filter'), name: Name }).strict(),
  z.object({ kind: z.literal('dependency'), package: Module, range: Range }).strict(),
  z
    .object({
      kind: z.literal('file_convention'),
      glob: Glob,
      symbol: z.string().min(1).max(100).optional().describe('Only usages with this symbol, for a pattern the usage adapter names.'),
    })
    .strict(),
]);
export type Match = z.infer<typeof Match>;
