# M5 - Finding schema, plan_migration prompt, lenses

**PRD refs:** sections 2 (judgment rows), 3, 5, 6.3, 8 (Specialists row), 11 (prompts and resources). **Done when:** it produces valid findings on one real repo.

## Scope

- In scope:
  - the Zod `Finding` and `Plan` schemas, exposed as MCP resources (JSON Schema)
  - a versioned `plan_migration` MCP prompt that instructs the host agent to run four independent lenses, each with its own evidence packet
  - a `submit_findings` path that schema-validates lens output on arrival, and retries once on invalid output
- Out of scope: dedupe and ordering (M6), the hard gates beyond schema validation (M6), confidence routing (M9).

## Tasks

1. **Schemas (`src/schema/finding.ts`, `src/schema/plan.ts`).** These follow PRD section 5 exactly.
   - `concern` enum: `api_change`, `behavior_change`, `dependency`, `config`, `test`, `build`, `docs`.
   - `severity` enum: `info`, `low`, `medium`, `high`, `blocker`.
   - `repo_id` on the finding and on every evidence entry (C10). In v0.1 it is always the run's single repo, and a mismatch is a schema error.
   - `evidence[]`: `{repo_id, file, line_start, line_end, snippet_hash}`.
   - `doc_refs[]`: `{library, version, url, doc_id}`. `doc_id` is added so gate 3 is a lookup rather than a URL string match.
   - `reasoning`, `action`, `rollback` (optional in the schema; gate 4 enforces it for high and above), `verify` (text; at L0 never executed, and at L1 the verify loop runs the user's declared checks, not this text), `confidence` (0 to 1).
   - `step_kind` enum: `codemod` or `manual`. When it is `codemod`, `codemod` must be a codemod ID listed by the rule's library (`library.json`, M3), and the finding lists which usages the codemod is expected to change.
   - `source` enum: `rule_pack`, `usage_scan`, `codemod`, `agent_judgment`.
   - Extra fields: `lens` (`api`, `dependency_build`, `behavior_runtime`, `verification`, or `combined` for a `small` run, M3), `rule_id?`, `usage_ids[]` (links to M2 usages; needed for gate 2), `docs_status` (`verified` or `unverified`, from M4), `prompt_version`.
   - A schema-level refinement rejects `source = agent_judgment` with empty `evidence` (PRD section 5).
   - `Plan`: `run_id`, `campaign_id`, `repo_id`, `pack`, `prompt_version`, `stages[] {id, order, title, finding_ids[], depends_on[]}`, `findings[]`, `out_of_scope[] {usage_id, reason, written_by}` (`written_by` is `scope`, `engine` or the lens; `docs/design.md` D16) and `unresolved[]`.
   - Export the JSON Schema through `zod-to-json-schema` (or the SDK's built-in conversion) as the resources `schema://finding` and `schema://plan`.
2. **Evidence packets (`src/pipeline/packets.ts`, tool `get_lens_packet`).** For each lens, a deterministic and size-bounded packet containing only what that lens needs. Which usage kinds go to which lens is **pack data** (a `lens` field per usage kind in the pack), not core code, so M10 adds Django without touching packets. For the Next.js pack:
   - **API:** async request API usages, removed or renamed imports, React API removals, the matching rules, the codemods that cover them, and the doc IDs for those symbols.
   - **Dependency/build:** `scan_repo` dependencies, peer-dependency conflicts, tsconfig, `next.config`, runtime target, and the rules with concern `dependency`, `build` or `config`.
   - **Behavior/runtime:** caching and segment config usages, behaviour-only changes, middleware, and data flow of `params` into client components, together with the risk signals from M3.
   - **Verification:** the test setup, test files mapped to modules through the import graph, modules with no covering test, the pack's `checks_hint` and the `verify_hint`s.

   - **Combined (`small` runs only):** one packet with what all four lenses would get, still size-bounded. A `small` run has at most `--small-max-usages` usages, so this stays small. `get_lens_packet` refuses `combined` unless the run's size is `small`, and refuses the four separate lenses for a `none` run.
   - Fetching the first packet freezes the run's scope (M3).
   - Usages the scope excluded are left out of every packet (`docs/design.md` D16).

   A packet never includes other lenses' findings, which keeps the lenses independent (PRD section 6.3). Packets contain file:line plus a bounded context, deny-list checked.
3. **Prompt (`prompts/plan_migration.v1.md`, registered as an MCP prompt).**
   - States the trigger and rejection rule: it requires a repo path, source@version and target@version; anything vaguer gets a question back.
   - Gives the tool order, which matches SKILL.md (M3). The skill generator embeds the prompt version, which keeps them in sync.
   - **Sizing and scope first.** After `assess_risk`, the agent calls `propose_scope`, shows the user the size and summary, and asks each question with its options. It never invents a question or an option. Then it calls `set_scope` with the answers. In a non-interactive session it calls `set_scope` with no answers, so the defaults apply.
   - **Then it branches on the size.** For `none`, it skips the lenses and goes straight to `merge_findings`, `validate_plan` and `emit_plan` (M6 builds the plan). For `small`, it runs the single `combined` lens. For `full`, it runs the four lenses below.
   - Gives per-lens narrow instructions. Each lens:
     - fetches its packet
     - calls Context7 for each distinct API symbol in the packet, then registers the docs via `get_migration_docs`
     - outputs findings **only** as schema JSON
     - cites only usage IDs and doc IDs it was given
     - marks a usage in its packet that needs no change (for example code already in the target form) as out of scope with a reason, rather than leaving it uncovered or writing a finding for it
     - sets `source` honestly
     - gives a rollback and a verify step for anything rated high or above
     - prefers a codemod step where the pack lists one, and states what the codemod leaves for manual work
   - **Contains no instruction to edit files or run commands.** This does not replace the code enforcement (C3); it only avoids prompting for it.
   - Prompts are versioned files. `v1` is never edited after release, and changes create `v2`. A test enforces this by comparing a hash recorded in `prompts/manifest.json`. The manifest also names the current version, the only one M7's eval scores (`docs/design.md` D17).
4. **`submit_findings` tool (`src/tools/submitFindings.ts`).**
   - Input: `run_id`, `lens`, `findings[]` and `out_of_scope[] {usage_id, reason}`. An `out_of_scope` entry must name a usage ID from this lens's packet and give a non-empty reason. It is stored with `written_by` set to the lens (`docs/design.md` D16). A submission in which the lens both marks a usage out of scope and writes a finding on it is invalid output: the whole submission is rejected, no item from it is stored, and it counts toward the retry policy below.
   - Parses each finding with Zod and normalises evidence: it re-reads the file through `SafePath` and recomputes `snippet_hash`. A mismatch is flagged here and gate 1 checks it again later.
   - Valid findings are stored. For invalid output (an invalid finding, an invalid `out_of_scope` entry, or a usage the lens both marks and covers) it returns the exact Zod errors and allows **one** retry per lens. After that it records a `lens.gap` event and moves on (reliability layer). Usages left uncovered by the gap stay uncovered unless another lens's finding or an out-of-scope entry covers them, and gate 2 sends them to `unresolved` (M6).
   - Stores findings both before and after normalisation as events (audit trail).
5. **Store (`src/store/findings.ts`, migration `005_findings.sql`).** `findings(run_id, id, lens, json, status, round)`. `004` is the doc cache from M4.
6. **Real-repo dry run.** Pick one public Next.js repo from the M0 golden list. Run the full flow in Claude Code or Cursor and save the transcript and findings under `eval/dryruns/m5/` (outside the target repo).

## Files and modules

`src/schema/{finding,plan,packet}.ts`, `src/pipeline/packets.ts`, `src/core/{getLensPacket,submitFindings}.ts`, `src/tools/{getLensPacket,submitFindings}.ts`, `src/store/findings.ts`, `src/store/migrations/005_findings.sql` (004 is the doc cache from M4), `src/security/promptFile.ts`, `prompts/plan_migration.v1.md`, `prompts/manifest.json`, `src/server.ts` (prompt and resource registration), `scripts/lib/build-pack.ts` (embeds the prompt version), `test/unit/{finding,packets,submitFindings,promptsImmutable}.test.ts`, `test/permissions/findings-read.test.ts`.

## Tests

- **Schema:** valid and invalid fixtures for every enum. A `codemod` step with an ID the rule's library doesn't list is rejected, and evidence with a different `repo_id` is rejected. `agent_judgment` with no evidence is rejected. `confidence` must be within 0 to 1.
- **Lens out of scope:** an entry naming a usage outside the lens's packet, or with an empty reason, is rejected and counts toward the retry policy, and so is a submission in which the lens both marks a usage out of scope and writes a finding on it, which stores none of its findings or entries; a valid entry is stored with `written_by` set to the lens.
- **Packet isolation:** the packet for lens A contains no finding IDs from lens B, even after lens B has submitted.
- **Packet scope:** a usage the scope excluded appears in no lens packet, including the combined one.
- **Packet bounds:** the maximum size is respected, and truncation is reported in the packet, never silent.
- **Retry policy:** the first invalid submit returns errors, the second invalid submit records `lens.gap`, and a third attempt is refused.
- **Prompt immutability:** editing `plan_migration.v1.md` fails the test.
- **Permissions:** the full suite. `submit_findings` evidence normalisation cannot read deny-listed or out-of-root files.

## Acceptance criteria

- On one real Next.js repo, all four lenses submit findings that pass schema validation, with at most one retry per lens. Results are stored and viewable by run ID.
- Every stored finding links to at least one usage ID or is explicitly `source=agent_judgment` with evidence.
- The prompt and skill reference the same tool order and the same prompt version.

## Risks

- **Host agents differ in how they follow MCP prompts** (Claude Code vs Cursor). Mitigation: test on both, keep the instructions short, and put the structure in schemas and tools rather than prose.
- **The agent cannot truly "fan out"**, so the lenses run sequentially in one context. Mitigation: isolation is enforced by what each packet contains and by asking for one lens per turn. True independence is approximated. Record this in `docs/design.md`.
- **Hallucinated APIs and confident wrong severity.** Mitigation: evidence and doc IDs are required, and gates come in M6, with calibration measured in M7.
- **Token cost.** Mitigation: bounded packets, and per-step token counts recorded when the host reports them.

## Dependencies

- M2 (usages and the import graph), M3 (rules and risk signals), M4 (doc IDs and docs status).

## Must not break

Earlier tools' outputs, the recall ratchet, pack lint, the Context7-down fallback, the permissions suite and the repo hash.
