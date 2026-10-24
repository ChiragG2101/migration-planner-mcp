# AGENTS.md

Instructions for coding agents working in this repository (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and others). It is the single source of project instructions; there is deliberately no `CLAUDE.md`. Shared agent assets (skills) live in `.agents/`; see `.agents/README.md`.

## Current state

**M1 done (2026-10-19). M2 done (2026-10-19). M3 done (2026-10-20, review approved in round 2). M4 done (2026-10-20, review approved in round 2). M5 done (2026-10-20, review approved). M6 done (2026-10-20). M7 done (2026-10-21): 7 Next.js golden cases with 3 engine runs + 3 baseline runs each (Cursor/databricks-claude-sonnet-4-6), engine 62.8% vs baseline 40.7% worst-case pooled recall, all gates pass. M8 done (2026-10-21, review approved; container mode cut per D42; live golden-case L1 runs are the D39/D41 handover). M9 done (2026-10-24, review approved in round 2).** The engine has the security layer, the SQLite event spine, ingest, `scan_repo`, the TS and Python language adapters with the import graph, the Next.js usage adapter, `find_usages`, the seeded-defect repo `eval/seeded/next-tricky/` with its recall ratchet, the Next.js and React knowledge with the `nextjs-upgrade` pack, `get_rule_pack`, `assess_risk`, `propose_scope`, `set_scope`, `get_migration_docs` (cache, formatter and retrieval log, with the Context7 client when `CONTEXT7_API_KEY` is set), `get_lens_packet` and `submit_findings` (MCP only), the deterministic aggregator `merge_findings`, the six hard gates and the `validate_plan` round loop (cap 3, `unresolved[]` kept visible), `emit_plan` (writes `plan.json` and `MIGRATION_PLAN.md` under `--out`), the versioned `plan_migration` prompt, the generated skill, and the CLI and MCP adapters. M7 adds the deterministic eval layer: the runner (`eval/runner.ts`), metrics (`eval/metrics.ts`), truth derivation (`scripts/derive-truth.ts`), the baseline prompt and parser, replay through HEAD's engine with Context7 disabled (`eval/replay.ts`), the byte-stable `eval/results.md` generator, the CI pack gate (`eval/packGate.ts`), the add-only check (`scripts/check-eval-add-only.ts`), the golden-case finder and re-checker, `.github/CODEOWNERS`, and the regression rule wired into CI (INV-25 bites from here). M8 adds the sandboxed verify loop: `src/security/exec.ts` (real spawn point with level guard, sandbox-path guard, scrubbed env, allowlisted git subcommands), `src/verify/checks.ts` (check config frozen at startup, D44), `src/verify/sandbox.ts` (git clone --no-hardlinks), `src/verify/codemods.ts` (ID → pinned tool + argv, exhaustive registry), `src/verify/testIntegrity.ts` (gate 7: 7 rules, TypeScript compiler API for TS/JS), `src/verify/loop.ts` (codemods → patch → checks → gate 7), `src/core/{verifyStage,submitStagePatch,getVerifyReport}.ts`, `src/tools/{verifyStage,submitStagePatch,getVerifyReport}.ts`, CLI `verify` and `report` commands, store migration 007, and the permissions + unit tests. Container mode cut (D42). M9 adds deterministic confidence routing at emit (`src/pipeline/routing.ts`: Review first, Needs human decision, `--confidence-threshold` default 0.6 kept per `eval/threshold.md`), the reordered `MIGRATION_PLAN.md`, per-stage `stages/<n>/CHECKLIST.md`, `run_report.md` built only from the run's events (`src/pipeline/report.ts`), `verify_report.json` at emit when L1 ran, the run budget (`--budget-tokens`, `--budget-seconds`, `budget.cut` events), `record_feedback` (tool, CLI `feedback`, migration 008, exports under `<out>/eval/feedback/`), `scripts/feedback-to-case.ts`, and `exec.run` events from an observer on the spawn point (D50 to D56). The pack update report for M3 (missing, stale and unseeded all none; 70 drafts left on purpose) lives in `.private/` and is not committed. `eval/results.md` is now regenerable and checked on every PR; it reports no recorded golden runs yet because the real cases and recorded runs are a live-session handover (D39). The repo holds the engine in `src/`, its tests in `test/`, the spec, the per-milestone plans, the spine docs, the golden-case records, and the recorded runs under `eval/runs/`:

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

Skills live in `.agents/skills/` (see `.agents/README.md`). Claude Code users run `scripts/link-agent-skills.sh` once, and again after pulling new skills. If your tool doesn't load them on its own, read the skill's `SKILL.md` directly before the task it covers (for example `.agents/skills/implement-milestone/SKILL.md` before building a milestone). `scripts/check-agent-skills.sh` checks the skills follow the rules. `scripts/check-spine.sh` checks the cross-references between the spine docs and the plans; run it after any change to `docs/`. A diff with no code is reviewed with the plan-review procedure in the `review-milestone` skill.

| Skill | Use it to |
| --- | --- |
| `implement-milestone` | Build a milestone inside its scope and run the gates |
| `review-milestone` | Review a milestone or PR against its plan, in a fresh session |
| `quiz-me` | Quiz yourself on a milestone or diff (optional, on request) |
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

  `cwd` is always inside `<out>/<run_id>/sandbox`, and the child environment is scrubbed. Commands never come from tool arguments, packs, knowledge, prompts or the agent. `--level 2` is refused as "not built in v0.1", and a tool argument can never raise the level.
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
- **Maintainer tools live in `scripts/` and are outside the engine:** the pack build and lint, the release drafter, the pack update report, and the golden-case finder and re-checker. The pack build and lint run offline in CI (the drift check and `npm run lint`). The other four may use the network and never run in default CI. `src/` never imports from `scripts/` or `eval/`.
- **Prompts are versioned files** (`prompts/plan_migration.v1.md`, `v2`, and so on). Never overwrite an existing version; add a new one.
- **Zod schemas in `src/schema/`** produce both the TS types and the MCP JSON Schema.
- **`snippet_hash`** uses one shared normaliser, which `find_usages`, finding normalisation and gate 1 all reuse.
- **Regression rule:** any change under `prompts/`, `knowledge/`, `packs/`, `src/rules/`, `src/analysis/` (usage adapters, risk, sizing), `src/pipeline/{aggregate,packets,routing}.ts`, `src/pipeline/gates/` or `src/verify/` (codemod registry, gate 7) requires regenerating `eval/results.md` in the same change. It applies from M7, when the eval runner exists; before that, say in the change that the rerun isn't possible yet.
- **Eval evidence is add-only.** From M7, existing golden cases and recorded runs are add-only on every PR, not only pack PRs, with two named exceptions (`scripts/check-eval-add-only.ts`, `docs/design.md` D15). The committed `eval/results.md` must equal the re-score of HEAD's tree, so never hand-edit it (D17).

## Tooling

Node 22.13 or later so `node:sqlite` needs no flag (`docs/design.md` D18), TypeScript 6.0 strict (not 7, D21), ESM, npm, Vitest, ESLint (flat `eslint.config.js`), the official MCP TS SDK v2 (`@modelcontextprotocol/server` 2.3.1, pinned), Zod. Licence Apache-2.0. The `typescript` compiler API (6.0.3, a runtime dependency) parses TS/JS; `web-tree-sitter` 0.27.1 with the vendored Python grammar in `src/lang/python/grammar/` parses Python (D26).

Commands that exist now:

- `npm install`, then `npm run build` (to `dist/`), `npm test`, `npm run test:permissions`, `npm run typecheck`, `npm run lint`.
- One test: `npx vitest run <path>` or `npx vitest run -t "<name>"`.
- Repo hash (INV-1): `npx tsx scripts/repo-hash.ts <root>`.
- Seeded recall (the smoke eval until M7): `npm run recall` regenerates `eval/seeded/recall.md`; `npm run recall -- --check [--base <git ref>]` fails below a floor in `eval/seeded/ratchet.json`, on a stale `recall.md`, or (with `--base`) on a lowered, removed or wrongly started floor (INV-50).
- CI (`.github/workflows/ci.yml`) runs typecheck, lint (pack lint included, with `BASE_SHA` set to the PR base), `npm test`, the recall ratchet against the PR base, the eval steps (smoke, add-only, the `check:core-untouched` allowlist for pack PRs against the PR base, the pack gate, and `eval --tier all --check`), the build, `npm run build:packs -- --check`, `check-spine.sh` and `check-agent-skills.sh` on every push and PR, on Linux and macOS (Windows is experimental and non-blocking). Dependabot (`.github/dependabot.yml`) opens weekly update PRs; never merge one that fails CI, and re-read the MCP SDK changelog before merging an SDK bump (D23).
- The CLI from a build: `node dist/cli/index.js scan <repo> --source <lib> --target <lib@ver> [--out <dir>] [--format text]`, `node dist/cli/index.js usages <repo> --source <lib> --target <lib@ver> [--kind <k>] [--file <f>] [--symbol <s>] [--limit <n>] [--cursor <c>] [--format text]`, `node dist/cli/index.js pack|risk|scope|docs <repo> --source <lib> --target <lib@ver>` (`scope --answers <file.json>` records the answers; `docs --register` or `--query` takes a JSON file), and `node dist/cli/index.js mcp` for the MCP server. Host wiring for Claude Code and Cursor is in `docs/design.md` (M1 task 10). Set `CONTEXT7_API_KEY` to let `docs` call Context7; without it the command stays offline.

Pitfalls found while building:

- `.gitignore` (from GitHub's Python and Node templates) ignores folders named `lib/`, `out/`, `build/` and `dist/` at any depth, and `.env.*` files. A committed fixture or seeded repo that uses those names silently loses those files from git. Use other names (`server/`, `utils/`), or create such files at test time. `scripts/lib/` is the exception: the plan names it, and `.gitignore` un-ignores it.
- `find_usages` caches each file's facts by its sha256, keyed by the adapter's `version`. When a change alters what a language or usage adapter extracts, bump that adapter's `version`, or stale cached facts are reused.
- Seeded repos under `eval/seeded/<repo>/` hold deliberately old code: the lint ignores them and the typecheck covers only `eval/seeded/*.ts`. Never "fix" the planted cases; `ground_truth.json` lines must keep pointing at them.

- `npm run build:packs` regenerates `SKILL.md` and `references/` (`--check` fails on drift; CI runs it). `npm run knowledge:draft -- <ecosystem>/<library> <release>` and `npm run pack:report -- <pack>` are maintainer tools and are not in default CI.
- `npm run lint` runs ESLint and then the pack lint (`scripts/lint-packs.ts`). The version-bump check needs a base (`--base <ref>` or `BASE_SHA`). CI sets `BASE_SHA` to the PR base on the lint step. A local `npm run lint` runs without a base. Do not weaken the "newest reviewed release" check.

Eval commands (M7): `npm run eval -- --tier unit|seeded|golden|baseline|all [--check] [--case <id>] [--pack <name>]` runs the runner in deterministic replay mode; `--check` fails if the committed `eval/results.md` differs from the re-score. `npm run eval:smoke` runs the seeded tier plus one golden case (in the milestone gates). `npm run eval:pack-gate` runs the CI pack gate over every pack under `packs/` at HEAD. `npm run eval:add-only -- [--base <ref>]` runs the add-only check (`scripts/check-eval-add-only.ts`); CI sets the base to the PR base. `npm run check:core-untouched -- [--base <ref>]` runs the "no core changes" allowlist for pack PRs (`scripts/check-core-untouched.ts`, a git-only wrapper over the pure, fully unit-tested `scripts/lib/coreUntouched.ts`, INV-27, D57); it self-skips on a core PR (nothing under `packs/` or `knowledge/`), and on a pack PR fails any change outside the tight allowlist (scoring code, `scripts/`, `prompts/`, other `src/`, another pack, a foreign `knowledge/` library or another pack's seeded repo all fail), a PR owning more than one pack, a `src/analysis/usages/registry.ts` change that is not a pure addition of at most one line (`removed === 0` and `added <= 1`; adapters register with one added line there, and `index.ts` collects them by id), a second new adapter file or an edit to an existing adapter, a case or run for another pack (an unreadable `case.json` fails closed), a changed pinned or other non-`notes`/`checks` field in a completed case, a deleted case folder or file, an edited or deleted `eval/cases/README.md` line, a `coverage-gaps.json` change that drops a base entry not prefixed with the owned pack or that is not a JSON array of strings (the owned pack's entries may be added or removed), a modified or deleted file under `test/`, a non-added `eval/history/` file, or a ratchet entry that existed on the base (a new floor equalling the measured recall is INV-50's `npm run recall -- --check --base`, and this check imports neither `src/` nor `eval/seeded/recall.ts`); CI runs it on every PR with the PR base, alongside `eval:add-only`. `npm run truth:derive -- <case-id>` derives a case's `truth.json` (maintainer, networked, not in default CI). `npm run runs:export` reads one run's store into an `EngineRun` (D41). The maintainer golden-case tools are `npm run cases:find -- <pack> --from <v> --to <v>` (writes candidates to `eval/.work/candidates/`) and `npm run cases:verify -- <id>|--all` (re-checks committed cases against GitHub, reading Node lockfiles and Python pins, including a nested lockfile when the root ones do not pin the library, D41); both use the network and never run in default CI. Live eval runs (opt-in, on the user's own key) are a handover (D39). The CLI's commands mirror the tools except `get_lens_packet` and `submit_findings`, which are MCP only (PRD §11). `docs`, `merge`, `validate` and `emit` are in place (`node dist/cli/index.js merge|validate|emit <repo> --source <lib> --target <lib@ver> [--out <dir>] [--format text]`, each running the scan-to-that-step pipeline), then `verify`, `report` and `feedback` (`node dist/cli/index.js feedback <repo> --source <lib> --target <lib@ver> --kind wrong|missing|severity_wrong|bad_patch|other --note "<text>" [--finding <id>] [--stage <id>] [--file <f> --line <n>]`). `emit` writes `plan.json`, `MIGRATION_PLAN.md`, `stages/<n>/CHECKLIST.md`, `run_report.md` and, after L1, `verify_report.json` under `<out>/<run_id>/`; `verify` emits again after the stages. Shared flags `--confidence-threshold <0..1>`, `--budget-tokens <n>` and `--budget-seconds <n>` apply to every command and to `mcp`. `npm run feedback:case -- <feedback.json> --annotate <case-id> --reviewer <name>` (or `--seeded`) is the manual, reviewed step that turns an exported feedback file into a golden-case annotation or a seeded ground-truth entry; it is not in CI. The current prompt is `prompts/plan_migration.v1.md`, named by `prompts/manifest.json`.

## Definition of done per milestone

A milestone is done when all of these hold:

- `npm test` passes, including `test/permissions/`, which is never skipped.
- The typecheck and the lint pass.
- The eval smoke set passes.
- The target-repo hash (`scripts/repo-hash.ts`) is unchanged after the demo.
- The spine docs are updated: `docs/invariants.md`, `docs/failure-modes.md` and `docs/design.md`.

An independent reviewer session also checks the diff against the milestone plan only, removes each new guard to confirm a test fails, and ends with a short plain-language summary for the user. It takes at most 2 rounds; open "must fix" items then go to the user (`docs/design.md` D19).

**Cut order if behind:** server-side Context7, then container sandbox mode, then the depth of the Django pack. Never cut the gates (including gate 7), the permissions rules, the eval or the clone-based verify loop.
