// Knowledge: facts about one library, kept by release (docs/design.md D10).
// `knowledge/<ecosystem>/<library>/library.json` says how the library numbers
// its releases and where its official docs live; `releases/<release>.json`
// holds the changes first made in that release plus later events for earlier
// rules. Every object rejects unknown keys, so no field can carry a command
// (C9); the pack lint also rejects command-like strings outside the display
// text fields (verify_hint, rollback_hint).
import { z } from 'zod';
import { Match } from './match.js';

export const Ecosystem = z.enum(['npm', 'pypi']);
export type Ecosystem = z.infer<typeof Ecosystem>;
export const VersionScheme = z.enum(['semver', 'pep440']);
export type VersionScheme = z.infer<typeof VersionScheme>;
export const ReleaseUnit = z.enum(['major', 'minor']);
export type ReleaseUnit = z.infer<typeof ReleaseUnit>;
export const Severity = z.enum(['info', 'low', 'medium', 'high', 'blocker']);
export type Severity = z.infer<typeof Severity>;
export const RuleEvent = z.enum(['deprecated', 'removed', 'changed_behavior', 'changed_default', 'renamed', 'peer_requirement']);
export type RuleEvent = z.infer<typeof RuleEvent>;

/** `npm/next`, `pypi/django`. */
export const LibraryId = z.string().regex(/^(npm|pypi)\/[a-z0-9][a-z0-9._-]*$/, 'an <ecosystem>/<library> ID');
/** A release unit or a finer version inside it, as written in knowledge: `15`, `13.2`, `4.2`, `5.2.1`. Checked against the scheme on load. */
const VersionText = z.string().regex(/^\d+(\.\d+){0,2}$/, 'a plain version such as 15, 13.2 or 4.2.1');
/** A rule ID, prefixed with the library's name: `next/async-request-apis`. */
export const RuleId = z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9-]*$/, 'a <library>/<rule> ID');
/** A codemod's registry ID, `<tool>:<transform>`; src/verify/codemodIds.ts lists the known ones. */
export const CodemodId = z.string().regex(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9.-]*$/, 'a <tool>:<transform> codemod ID');
const HttpsUrl = z.url({ protocol: /^https$/ });
const Text = z.string().trim().min(1).max(2000);

export const Codemod = z.object({ id: CodemodId, notes: Text }).strict();

const NotesLocation = z.object({ fetch: HttpsUrl, page: HttpsUrl }).strict();

export const Library = z
  .object({
    id: LibraryId,
    ecosystem: Ecosystem,
    packages: z.array(z.string().min(1)).min(1).describe('The package names this knowledge covers.'),
    language: z.enum(['ts', 'python']),
    version_scheme: VersionScheme,
    release_unit: ReleaseUnit,
    lts: z.array(VersionText).optional(),
    covered_from: VersionText.describe('The oldest release whose knowledge is complete.'),
    doc_sources: z.array(z.string().min(1)).min(1).describe('Official doc locations, as https:// URL prefixes ending in /.'),
    release_notes: z
      .object({
        fetch: z.string().min(1).describe('URL template of the raw notes file, with {version}.'),
        page: z.string().min(1).describe('URL template of the public page the notes come from, with {version}.'),
        overrides: z.record(VersionText, NotesLocation).optional().describe('Releases whose notes do not follow the templates.'),
        format: z.enum(['md', 'mdx', 'rst']),
        sections: z.array(Text).min(1).describe('Headings whose items list breaking changes, removals and deprecations.'),
      })
      .strict(),
    codemods: z.array(Codemod),
  })
  .strict();
export type Library = z.infer<typeof Library>;

const ruleCore = {
  id: RuleId,
  title: Text,
  event: RuleEvent,
  version: VersionText.optional().describe('A finer version inside the release, for a change made in a minor or patch release.'),
  source: HttpsUrl.describe('One official URL, under a doc_sources prefix, for the section that documents the change.'),
};

const ReviewedRule = z
  .object({
    ...ruleCore,
    status: z.literal('reviewed'),
    replacement_since: VersionText.optional().describe('The release in which the new form first existed.'),
    match: Match,
    concern: Text,
    default_severity: Severity,
    mapping: z.object({ from: Text, to: Text }).strict(),
    no_equivalent: z.boolean(),
    codemod: CodemodId.optional(),
    notes: z.string().max(4000),
    verify_hint: Text,
    rollback_hint: Text,
    requires: z.object({ library: LibraryId, range: z.string().min(1).max(200) }).strict().optional(),
    doc_topics: z.array(Text).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.event === 'peer_requirement' && !r.requires) ctx.addIssue({ code: 'custom', path: ['requires'], message: 'a peer_requirement rule needs requires {library, range}' });
    if (r.event !== 'peer_requirement' && r.requires) ctx.addIssue({ code: 'custom', path: ['requires'], message: 'requires is only for peer_requirement rules' });
  });

/** A draft from the release drafter: the same fields, any of them still empty. Drafts never load (INV-36). */
const DraftRule = z
  .object({
    ...ruleCore,
    status: z.literal('draft'),
    replacement_since: VersionText.optional(),
    match: Match.optional(),
    concern: z.string().max(2000).optional(),
    default_severity: Severity.optional(),
    mapping: z.object({ from: z.string().max(2000), to: z.string().max(2000) }).strict().optional(),
    no_equivalent: z.boolean().optional(),
    codemod: CodemodId.optional(),
    notes: z.string().max(4000).optional(),
    verify_hint: z.string().max(2000).optional(),
    rollback_hint: z.string().max(2000).optional(),
    requires: z.object({ library: LibraryId, range: z.string().max(200) }).strict().optional(),
    doc_topics: z.array(z.string().max(2000)).optional(),
  })
  .strict();

export const Rule = z.discriminatedUnion('status', [ReviewedRule, DraftRule]);
export type Rule = z.infer<typeof Rule>;
export type ReviewedRule = z.infer<typeof ReviewedRule>;
export type DraftRule = z.infer<typeof DraftRule>;

/** A later event for a rule defined in an earlier release file. */
export const LaterEvent = z
  .object({
    rule: RuleId,
    event: RuleEvent.exclude(['peer_requirement']),
    version: VersionText.optional(),
    source: HttpsUrl.optional(),
  })
  .strict();
export type LaterEvent = z.infer<typeof LaterEvent>;

export const ReleaseFile = z
  .object({
    library: LibraryId,
    release: VersionText,
    area: z.string().regex(/^[a-z0-9-]+$/).optional().describe('Set when a large release is split into area files.'),
    rules: z.array(Rule),
    events: z.array(LaterEvent),
  })
  .strict();
export type ReleaseFile = z.infer<typeof ReleaseFile>;
