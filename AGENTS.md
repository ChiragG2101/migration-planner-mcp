# AGENTS.md

Instructions for coding agents working in this repository (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and others). It is the single source of project instructions; there is deliberately no `CLAUDE.md`. Shared agent assets (skills) live in `.agents/`; see `.agents/README.md`.

## Current state

**Pre-code: M0 done, no `package.json` or test setup yet.** M0 (spine docs and golden cases) is complete; code starts at M1. The repo holds the spec, the per-milestone plans, the spine docs and the golden-case records:

- `docs/PRD.md`: the product requirements and build spec. This is the source of truth.
- `docs/plans/00-overview.md`: the cross-cutting constraints (C1 to C10), the tech decisions, the per-milestone gates, the cut order and the target source layout.
- `docs/plans/01-...` to `10-...`: one plan per milestone (M1 to M10). Each lists scope, tasks, files, tests, acceptance criteria and "must not break". M0 and M11 live in the overview.
- `docs/design.md`, `docs/invariants.md`, `docs/failure-modes.md`: the spine docs (M0). Invariants name *planned* test paths until the owning milestone adds the code and test.
- `plan.md`: the milestone checklist index. `eval/cases/`: the golden-case records (M0); base commits are pinned, truth is derived from M7.

Before you implement a milestone, read its plan file and the overview. Don't invent commands or files the plans don't describe. When you add tooling, update this file with the real commands.

`.private/` is gitignored and holds research, rationale and internal notes. The repo will be open source, so put research and decision notes there, not in `docs/`.

## Working rules for agents

These apply to every change, in any tool.

1. **Work from the plan.** For milestone work, read the milestone file and the overview first, and stay inside its Scope. Extras go in a "noticed, not done" list for the user, not in the diff.
2. **Ask instead of guessing** when the plan, a constraint or the user's intent is unclear. Decisions you do make go in `docs/design.md`.
3. **Never weaken a constraint, a gate or a test to make something pass.** No skipped, deleted or loosened tests and no lowered thresholds. Raise it with the user instead.
4. **Tests come with the code.** Every guard gets a test that fails when the guard is removed (see the `write-tests` skill).
5. **Report honestly.** Say what you ran and what it printed. Never call a gate passed without running it; if a command doesn't exist yet, say so.
6. **Keep the docs in step.** Update the spine docs and this file in the same change (`update-spine-docs` skill).
7. **Independent review.** Whoever builds a milestone does not review it. The review runs in a fresh session (`review-milestone` skill).

## Contributor skills

Skills live in `.agents/skills/` (see `.agents/README.md`). Claude Code users run `scripts/link-agent-skills.sh` once, and again after pulling new skills. `scripts/check-agent-skills.sh` checks the skills follow the rules.

| Skill | Use it to |
| --- | --- |
| `implement-milestone` | Build a milestone inside its scope and run the gates |
| `review-milestone` | Review a milestone or PR against its plan, in a fresh session |
| `quiz-me` | Run the comprehension check after a milestone |
| `write-tests` | Write tests, especially permissions and gate tests |
| `add-pack` | Add a migration pack without touching the core |
| `add-release-knowledge` | Draft, complete and review the rules for one library release under `knowledge/` |
| `add-golden-case` | Find, vet and add a real migration PR as an eval case |
| `update-spine-docs` | Keep invariants, failure modes and design decisions current |

## What is being built

A local-first **migration engine plus migration packs**. The engine is general (run state, plan schema, gates, verify loop, eval, permissions). Each migration is a pack: a thin `pack.json` over per-library knowledge (the rules, kept by release, with their codemod references), a verification hint and golden cases. Pack 1 is a **Next.js major upgrade**; pack 2 is a **Django LTS to LTS upgrade**, there to prove the engine works for a second language without core changes. The working name is `migration-planner-mcp`; the final name is chosen in M10.

Delivery layers: a core library in `src/core/`, with thin adapters over it: a CLI (`src/cli/`), a stdio MCP server (`src/server.ts`, `src/tools/`), and generated skills. Adapters contain no logic. The host agent (Claude Code, Cursor) is the LLM; the engine is deterministic and never uses MCP sampling or an LLM SDK.

Pipeline: `Ingest -> Context build (scan_repo, find_usages via language adapters) -> size and scope (propose_scope: none/small/full plus scope questions; set_scope narrows only) -> four lenses (one combined lens for small, none skips them) run by the host agent via the plan_migration prompt -> merge_findings -> validate_plan (gates 1-6, max 3 rounds) -> emit (plan, checklists, run report) -> at L1 only: verify loop (sandbox, codemods, agent patch, declared checks, gate 7, keep or roll back, patches out)`. Every step is recorded in a SQLite event spine keyed by run ID, under campaign and repo IDs.

## Non-negotiable constraints

These are enforced in code, not in prose. A change that breaks one of them is wrong, whatever else it does. Their IDs (C1 to C10) are in the overview.

- **The user's repo is never written, at any level.** `src/security/safeWrite.ts` is the only module that writes files, and only under `--out` (default `.migration-planner/`, outside the source tree). The engine refuses to start if `--out` resolves inside the repo.
- **No execution at L0** (the default). At `--level 1`, `src/security/exec.ts` is the **only** spawn point. It runs only:
  - the user's declared install and check commands (CLI flags, or the AGENTS.md snippet with `--trust-repo-checks`), as argv with no shell;
  - allowlisted codemods from `src/verify/codemods.ts`, at pinned versions;
  - a fixed set of git operations, with hooks disabled.

  `cwd` is always inside `<out>/<run_id>/sandbox`, and the child environment is scrubbed. Commands never come from tool arguments, packs, prompts or the agent. `--level 2` is refused as "not built in v0.1", and a tool argument can never raise the level.
- **Path boundary.** All reads go through `resolveInside(root, p)`, which returns a branded `SafePath` carrying the `repo_id`. It realpaths both sides, so `..`, absolute paths and symlink escapes are rejected. Deny-listed files (`.env*`, keys, `.npmrc`, `.pypirc`, and so on) are never read. The AGENTS.md snippet can only *add* deny entries.
- **Pack and knowledge data never executes.** `packs/` and `knowledge/` hold only JSON and Markdown. They name a codemod by allowlist ID only, never by command, and their schemas reject command-like fields.
- **Network (the engine's own).** Only Context7 (`src/docs/context7.ts`), only when configured, and with a typed payload carrying library names, versions and symbols only, never repo contents. The engine works offline through the cache. No telemetry.
- **Campaign and repo IDs everywhere,** but v0.1 behaviour is single-repo. More than one repo is refused with "not built in v0.1".
- **Storage** is SQLite (`node:sqlite`, falling back to `better-sqlite3`) plus plain files, all through `src/store/`. No vector DB.
- **stdout is the MCP protocol channel.** Logs and startup banners go to stderr.
- The README says "currently building" until v0.1 ships (M11) with real eval numbers.

## Architecture rules that span files

- **Language adapters** (`src/lang/`) share one `LanguageAdapter` interface: TS/JS through the TypeScript compiler API, and Python through tree-sitter WASM (no native build, no subprocess). A line-based text scanner covers templates and config. **Usage adapters** (`src/analysis/usages/`) are per pack and registered with one line.
- **Pack-specific behaviour is data, not core code:** which lens gets which usage kind and the staging strategy (`leaf_first` or `config_first`) live in `pack.json`, and codemod references live in the knowledge. Adding a pack must not touch protected core paths; `scripts/check-core-untouched.ts` enforces this from M10.
- **Gates are deterministic and independent.**
  - Gates 1-6 (`src/pipeline/gates/g1..g6-*.ts`) run on the plan.
  - Gate 7, test integrity (`src/verify/testIntegrity.ts`), runs on L1 stage patches. It fails the stage on fewer tests or assertions, new skip/only/xfail markers, deleted tests or snapshots, lowered coverage thresholds, or edited check definitions.
  - All gates share one `Gate` interface, re-check against real files, and import no network or model code.
  - After 3 rounds or attempts, failures go to `unresolved[]` and are never marked passed.
- **Knowledge and packs are data, in two layers** (`docs/design.md` D10).
  - `knowledge/<ecosystem>/<library>/` holds the facts: `library.json` (version scheme, release unit, LTS list, official doc sources and release notes, codemods) and one `releases/<release>.json` per release. Release files only gain entries for their own release.
  - `packs/<pack>/pack.json` is thin: which libraries, the checked range, the usage adapter, staging, the trigger. It holds no rules.
  - Necessity (`breaks` or `deprecated`) and `lands_on` are derived per run from the rules' events, never typed in.
  - Only `reviewed` rules load. New rules start as drafts from `npm run knowledge:draft` (the `add-release-knowledge` skill).
  - `SKILL.md`, `references/` and the plugin bundle are *generated* from the pack plus its knowledge (with a "do not edit" banner), so edit the data and regenerate rather than editing generated files. CI fails on drift. SKILL.md stays at most about 100 lines with a narrow trigger sentence.
- **Maintainer tools live in `scripts/` and are outside the engine:** the pack build and lint, the release drafter, the pack update report, and the golden-case finder and re-checker. The pack build and lint run offline in CI (the drift check and `npm run lint`). The other four may use the network and never run in default CI. `src/` never imports from `scripts/`.
- **Prompts are versioned files** (`prompts/plan_migration.v1.md`, `v2`, and so on). Never overwrite an existing version; add a new one.
- **Zod schemas in `src/schema/`** produce both the TS types and the MCP JSON Schema.
- **`snippet_hash`** uses one shared normaliser, which `find_usages`, finding normalisation and gate 1 all reuse.
- **Regression rule:** any change under `prompts/`, `knowledge/`, `packs/`, `src/rules/`, `src/analysis/` (usage adapters, risk, sizing), `src/pipeline/{aggregate,packets,routing}.ts`, `src/pipeline/gates/` or `src/verify/` (codemod registry, gate 7) requires regenerating `eval/results.md` in the same change. It applies from M7, when the eval runner exists; before that, say in the change that the rerun isn't possible yet.

## Planned tooling (from M1; confirm once it exists)

Node 22 LTS, TypeScript strict, ESM, npm, Vitest, ESLint, the official MCP TS SDK v2 (`@modelcontextprotocol/server`, pinned version), the `typescript` compiler API, `web-tree-sitter` with the Python grammar, Zod. Licence Apache-2.0.

Planned scripts: `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` (which includes `scripts/lint-packs.ts`), `npm run test:permissions`, `npm run build:packs`, `npm run eval:smoke`, and `npm run eval -- --tier all`. Maintainer tools (network, manual): `npm run knowledge:draft -- <library> <release>`, `npm run pack:report -- <pack>`, `npm run cases:find -- <pack> --from <v> --to <v>` and `npm run cases:verify -- <id>|--all`. The CLI's commands mirror the tools (`scan`, `usages`, `pack`, `risk`, `scope`, `docs`, `merge`, `validate`, `emit`, `verify`, `report`, `feedback`), and `mcp` starts the MCP adapter. To run a single test, use `npx vitest run <path>` or `-t "<name>"`.

## Definition of done per milestone

A milestone is done when all of these hold:

- `npm test` passes, including `test/permissions/`, which is never skipped.
- The typecheck and the lint pass.
- The eval smoke set passes.
- The target-repo hash (`scripts/repo-hash.ts`) is unchanged after the demo.
- The spine docs are updated: `docs/invariants.md`, `docs/failure-modes.md` and `docs/design.md`.

An independent reviewer session also checks the diff against the milestone plan only.

**Cut order if behind:** server-side Context7, then container sandbox mode, then the depth of the Django pack. Never cut the gates (including gate 7), the permissions rules, the eval or the clone-based verify loop.
