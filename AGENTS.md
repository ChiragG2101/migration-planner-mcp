# AGENTS.md

Instructions for coding agents working in this repository (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and others). It is the single source of project instructions; there is deliberately no `CLAUDE.md`. Shared agent assets (skills) live in `.agents/`; see `.agents/README.md`.

## Current state

**Planning stage only. There is no code, `package.json` or test setup yet.** The repo holds the spec and per-milestone plans:

- `docs/PRD.md`: the product requirements and build spec. This is the source of truth.
- `docs/plans/00-overview.md`: the cross-cutting constraints (C1 to C10), the tech decisions, the per-milestone gates, the cut order and the target source layout.
- `docs/plans/01-...` to `10-...`: one plan per milestone (M1 to M10). Each lists scope, tasks, files, tests, acceptance criteria and "must not break". M0 and M11 live in the overview.

Before you implement a milestone, read its plan file and the overview. Don't invent commands or files the plans don't describe. When you add tooling, update this file with the real commands.

`.private/` is gitignored and holds research, rationale and internal notes. The repo will be open source, so put research and decision notes there, not in `docs/`.

## What is being built

A local-first **migration engine plus migration packs**. The engine is general (run state, plan schema, gates, verify loop, eval, permissions). Each migration is a pack: rules, codemod references, a verification hint and golden cases. Pack 1 is a **Next.js major upgrade**; pack 2 is a **Django LTS to LTS upgrade**, there to prove the engine works for a second language without core changes. The working name is `migration-planner-mcp`; the final name is chosen in M10.

Delivery layers: a core library in `src/core/`, with thin adapters over it: a CLI (`src/cli/`), a stdio MCP server (`src/server.ts`, `src/tools/`), and generated skills. Adapters contain no logic. The host agent (Claude Code, Cursor) is the LLM; the engine is deterministic and never uses MCP sampling or an LLM SDK.

Pipeline: `Ingest -> Context build (scan_repo, find_usages via language adapters) -> four lenses run by the host agent via the plan_migration prompt -> merge_findings -> validate_plan (gates 1-6, max 3 rounds) -> emit (plan, checklists, run report) -> at L1 only: verify loop (sandbox, codemods, agent patch, declared checks, gate 7, keep or roll back, patches out)`. Every step is recorded in a SQLite event spine keyed by run ID, under campaign and repo IDs.

## Non-negotiable constraints

These are enforced in code, not in prose. A change that breaks one of them is wrong, whatever else it does. Their IDs (C1 to C10) are in the overview.

- **The user's repo is never written, at any level.** `src/security/safeWrite.ts` is the only module that writes files, and only under `--out` (default `.migration-planner/`, outside the source tree). The engine refuses to start if `--out` resolves inside the repo.
- **No execution at L0** (the default). At `--level 1`, `src/security/exec.ts` is the **only** spawn point. It runs only:
  - the user's declared install and check commands (CLI flags, or the AGENTS.md snippet with `--trust-repo-checks`), as argv with no shell;
  - allowlisted codemods from `src/verify/codemods.ts`, at pinned versions;
  - a fixed set of git operations, with hooks disabled.

  `cwd` is always inside `<out>/<run_id>/sandbox`, and the child environment is scrubbed. Commands never come from tool arguments, packs, prompts or the agent. `--level 2` is refused as "not built in v0.1", and a tool argument can never raise the level.
- **Path boundary.** All reads go through `resolveInside(root, p)`, which returns a branded `SafePath` carrying the `repo_id`. It realpaths both sides, so `..`, absolute paths and symlink escapes are rejected. Deny-listed files (`.env*`, keys, `.npmrc`, `.pypirc`, and so on) are never read. The AGENTS.md snippet can only *add* deny entries.
- **Pack data never executes.** Packs are JSON and Markdown. A pack names a codemod by allowlist ID only, never by command.
- **Network (the engine's own).** Only Context7 (`src/docs/context7.ts`), only when configured, and with a typed payload carrying library names, versions and symbols only, never repo contents. The engine works offline through the cache. No telemetry.
- **Campaign and repo IDs everywhere,** but v0.1 behaviour is single-repo. More than one repo is refused with "not built in v0.1".
- **Storage** is SQLite (`node:sqlite`, falling back to `better-sqlite3`) plus plain files, all through `src/store/`. No vector DB.
- **stdout is the MCP protocol channel.** Logs and startup banners go to stderr.
- The README says "currently building" until real eval numbers exist.

## Architecture rules that span files

- **Language adapters** (`src/lang/`) share one `LanguageAdapter` interface: TS/JS through the TypeScript compiler API, and Python through tree-sitter WASM (no native build, no subprocess). A line-based text scanner covers templates and config. **Usage adapters** (`src/analysis/usages/`) are per pack and registered with one line.
- **Pack-specific behaviour is pack data, not core code:** which lens gets which usage kind, the staging strategy (`leaf_first` or `config_first`), and codemod references. Adding a pack must not touch protected core paths; `scripts/check-core-untouched.ts` enforces this from M10.
- **Gates are deterministic and independent.**
  - Gates 1-6 (`src/pipeline/gates/g1..g6-*.ts`) run on the plan.
  - Gate 7, test integrity (`src/verify/testIntegrity.ts`), runs on L1 stage patches. It fails the stage on fewer tests or assertions, new skip/only/xfail markers, deleted tests or snapshots, lowered coverage thresholds, or edited check definitions.
  - All gates share one `Gate` interface, re-check against real files, and import no network or model code.
  - After 3 rounds or attempts, failures go to `unresolved[]` and are never marked passed.
- **Rule packs are data.** `rules/<pack>/rules.json` is the single source. `SKILL.md`, `references/` and the plugin bundle are *generated* from it (with a "do not edit" banner), so edit `rules.json` and regenerate rather than editing generated files. CI fails on drift. SKILL.md stays at most about 100 lines with a narrow trigger sentence.
- **Prompts are versioned files** (`prompts/plan_migration.v1.md`, `v2`, and so on). Never overwrite an existing version; add a new one.
- **Zod schemas in `src/schema/`** produce both the TS types and the MCP JSON Schema.
- **`snippet_hash`** uses one shared normaliser, which `find_usages`, finding normalisation and gate 1 all reuse.
- **Regression rule:** any change under `prompts/`, `rules/`, `src/pipeline/gates/` or `src/verify/` (codemod registry, gate 7) requires regenerating `eval/results.md` in the same change.

## Planned tooling (from M1; confirm once it exists)

Node 22 LTS, TypeScript strict, ESM, npm, Vitest, ESLint, the official MCP TS SDK v2 (`@modelcontextprotocol/server`, pinned version), the `typescript` compiler API, `web-tree-sitter` with the Python grammar, Zod. Licence Apache-2.0.

Planned scripts: `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` (which includes `scripts/lint-packs.ts`), `npm run test:permissions`, `npm run build:packs`, `npm run eval:smoke`, and `npm run eval -- --tier all`. The CLI's commands mirror the tools (`scan`, `usages`, `pack`, `risk`, `docs`, `merge`, `validate`, `emit`, `verify`, `report`, `feedback`), and `mcp` starts the MCP adapter. To run a single test, use `npx vitest run <path>` or `-t "<name>"`.

## Definition of done per milestone

A milestone is done when all of these hold:

- `npm test` passes, including `test/permissions/`, which is never skipped.
- The typecheck and the lint pass.
- The eval smoke set passes.
- The target-repo hash (`scripts/repo-hash.ts`) is unchanged after the demo.
- The spine docs are updated: `docs/invariants.md`, `docs/failure-modes.md` and `docs/design.md`.

An independent reviewer session also checks the diff against the milestone plan only.

**Cut order if behind:** server-side Context7, then container sandbox mode, then the depth of the Django pack. Never cut the gates (including gate 7), the permissions rules, the eval or the clone-based verify loop.
