# 00 - Implementation plan overview

This folder turns [`docs/PRD.md`](../PRD.md) into milestone plans. It is a plan, not an implementation. Each milestone file (`01` to `10`, matching M1 to M10) lists its scope, tasks, files and modules, tests, acceptance criteria, risks and dependencies.

The project in one paragraph: a general migration engine (run state, plan schema, gates, verify loop, eval, permissions) with migration packs plugged in. The CLI, the MCP server and generated skills are thin adapters over the same engine. Pack 1 is a Next.js major upgrade and is the one pack in v0.1. Pack 2 is a Django LTS to LTS upgrade, chosen to prove the engine works for a second language; it is v0.2 (M12, `docs/design.md` D60). L0 (report only) is the default; L1 applies and verifies each stage in a sandbox copy and emits patches. The user's repo is never written.

## Non-negotiable constraints (apply to every milestone)

These come from PRD sections 1, 3 and 7A. A milestone that breaks one of them is not done, whatever else it ships.

| ID | Constraint | How it is enforced |
| --- | --- | --- |
| C1 | **Local-first, zero cost.** No hosted services, no paid APIs. The MCP adapter uses stdio only. Context7 is optional and works on its free tier or with no key at all. | No HTTP listener in `src/`. Dependency review at every milestone. The engine must run fully offline (Context7 falls back to the cache, see M4). |
| C2 | **SQLite plus plain files** is the only storage. No vector DB, Postgres or Redis. | One store module (`src/store/`). Everything else goes through it. |
| C3 | **The user's repo is never written. No execution in L0.** L1 executes only through `src/security/exec.ts`, the single spawn point, which enforces a command allowlist and pins the working directory inside the sandbox. | Within the engine (`src/`), `src/security/` is the only module allowed to import `node:fs` write APIs or `node:child_process`. A lint rule and the permissions suite check this (M1, M8). Nothing under `src/` may import `scripts/` or `eval/`, which write files and run git outside that rule (import lint, M3). |
| C4 | **Path boundary.** Every path is resolved against the ingest root. `..`, absolute paths outside the root and symlink escapes are rejected. Deny-listed files (`.env*`, keys, user denies) are never read. | `security/pathBoundary.ts` plus `security/denyList.ts`, tested in `test/permissions/`. |
| C5 | **Autonomy is opt-in.** L0 (plan, checklists, report) is the default. L1 (sandboxed apply and verify, patches out) needs `--level 1`. L2 (write branches to the user's repo) is not built in v0.1. A tool argument can never raise the level. | `security/level.ts`. Every write and every exec checks the level first. |
| C6 | **Network allowlist (the engine's own traffic).** Only Context7, and only when configured. No telemetry. Only library names, versions and API symbol names are sent; repo contents never leave the machine. Network used by the user's declared check commands inside the sandbox is theirs and is reported, not hidden. | `src/docs/context7.ts` is the only network module, and it takes a typed payload with no free-text field. A test asserts the outbound payload shape. |
| C7 | **The host agent is the LLM.** No MCP sampling. The engine is deterministic. | No LLM SDK dependency in the engine core. |
| C8 | **Honest claims.** The README says "currently building" until v0.1 ships (M11) with real eval numbers. | Checked as part of the M10 review. |
| C9 | **Pack and knowledge data never executes.** Packs and knowledge (`packs/`, `knowledge/`) are JSON and Markdown. They reference codemods only by allowlist ID; commands for checks come only from user-owned config (CLI flags or the AGENTS.md snippet), never from packs, knowledge, prompts, tool arguments or the agent. | The knowledge and pack schemas reject unknown keys and command-like fields, and the pack lint rejects non-data files (M3). `verify/codemods.ts` is the only ID-to-command mapping (M8). Permissions tests (M8). |
| C10 | **Campaign and repo IDs everywhere.** Runs, usages, findings and evidence carry `repo_id` under a `campaign_id`. v0.1 behaviour is single-repo: a request naming more than one repo is refused with "not built in v0.1". | Store schema from M1. A test asserts the refusal. |

## Milestone map

| # | Plan file | Deliverable (PRD section 12) | Depends on |
| --- | --- | --- | --- |
| M0 | (this file, section below) | `docs/failure-modes.md`, `docs/invariants.md`, golden cases chosen for both packs | none |
| M1 | [`01-engine-skeleton-scan-repo-permissions.md`](01-engine-skeleton-scan-repo-permissions.md) | Engine skeleton, CLI and MCP adapters, `scan_repo` (JS/TS and Python), event log with campaign and repo IDs, path boundary, read-only rule | M0 |
| M2 | [`02-language-adapters-find-usages.md`](02-language-adapters-find-usages.md) | TS and Python language adapters, import graphs, `find_usages` for Next.js, usage index | M1 |
| M3 | [`03-rule-pack-assess-risk-skill.md`](03-rule-pack-assess-risk-skill.md) | Knowledge and pack schema (per-library releases, version schemes, range composition), Next.js knowledge and pack, `get_rule_pack`, `assess_risk`, sizing and scope (`propose_scope`, `set_scope`), generated skill, release drafter and pack update report | M1, M2 |
| M4 | [`04-context7-docs-cache.md`](04-context7-docs-cache.md) | Context7 integration, retrieval log, cache | M1 (M3 for the fallback content and `officialUrl.ts`) |
| M5 | [`05-finding-schema-prompt-lenses.md`](05-finding-schema-prompt-lenses.md) | Finding schema, `plan_migration` prompt, four lenses | M2, M3, M4 |
| M6 | [`06-merge-findings-validate-plan.md`](06-merge-findings-validate-plan.md) | `merge_findings`, `validate_plan` gates 1 to 6, emit | M5 |
| M7 | [`07-eval-runner-golden-baseline.md`](07-eval-runner-golden-baseline.md) | Eval runner, 5 Next.js golden cases, baseline run, golden-case finder and re-checker | M6 |
| M8 | [`08-sandboxed-verify-loop.md`](08-sandboxed-verify-loop.md) | Sandboxed verify loop (L1), codemod registry, gate 7 (test integrity), outcome metrics | M6, M7 |
| M9 | [`09-confidence-feedback-report.md`](09-confidence-feedback-report.md) | Confidence routing, `record_feedback`, run report | M6, M7, M8 |
| M10 | [`10-snippet-readme-oss-demo.md`](10-snippet-readme-oss-demo.md) | AGENTS.md snippet, "no core changes" check, L1 eval evidence for Next.js, README, open-source files, plugin bundle, demo, name decided (the Django pack moved to M12, D60) | M3, M7, M8, M9 |
| M11 | (this file, section below) | npm publish, tag v0.1 | M10 |
| M12 | [`12-django-pack.md`](12-django-pack.md) | v0.2: Django pack (no core changes), beating the baseline | M11 |

M4 can run in parallel with M2 and M3 once M1 lands, except that M4's `official` labelling needs `src/docs/officialUrl.ts` from M3 task 7, so that file lands before M4's labelling. Everything else runs in order.

**Cut order if behind:** server-side Context7 (a stretch goal anyway), then container sandbox mode (keep the clone sandbox). The Django pack left v0.1 on 2026-11-01 (M12, D60); within M12 the cut is its depth (fewer rules, same golden cases and the same "no core changes" check). **Never cut** the gates (M6 and gate 7 in M8), the permissions rules (M1 and every later milestone), the eval (M7) or the clone-based verify loop (M8).

## M0 - Spine docs and golden cases (pre-code)

- **Scope:** write the spine files and pick the eval cases before writing code (PRD sections 8, 10 and 12).
- **Tasks:**
  1. `docs/design.md`: a link to the PRD, plus decisions taken during the build. The decisions table below gives the first entries.
  2. `docs/invariants.md`: numbered invariants, each with the test that proves it, for example "INV-1: the target repo is never written (test/permissions/no-repo-write.test.ts)". It starts with C3 to C6, C9, C10 and the 7 gates.
  3. `docs/failure-modes.md`: the PRD section 8 matrix, with a "test or check" column added.
  4. `plan.md` at the repo root: a short milestone checklist that links here.
  5. **Next.js golden cases.** Find at least 3 public Next.js major-upgrade PRs (the target is 5 to 8 by M7, including one messy or partly reverted upgrade). Prefer repos with a real test suite, so M8 can use them too. Record the repo URL, base commit, merge commit, PR URL, from and to versions in `eval/cases/README.md`.
  6. **Django golden cases.** Find at least 2 public Django LTS to LTS upgrade PRs with a runnable test suite. Same record format. This is early on purpose: if good cases are scarce, M10's scope is decided now, not at the end.
- **Acceptance:** all files exist, and each golden case has a pinned base commit that can be checked out.
- **Risk:** good migrations are hard to find (PRD section 15). Start this search now. Candidate sources: GitHub search for merged PRs titled with the upgrade, filtered to repos with CI and tests; framework showcase lists.

## Cross-cutting technical decisions (confirm in M1, record in `docs/design.md`)

| Decision | Default | Why | Fallback |
| --- | --- | --- | --- |
| Runtime | Node.js 22 LTS, 22.13 or later (`docs/design.md` D18), TypeScript strict, ESM | Matches the MCP TS SDK and the TypeScript compiler API | none |
| Engine shape | A core library (`src/core/`) with CLI and MCP adapters | One engine, several delivery surfaces; the CLI serves CI and non-agent users | none |
| MCP SDK | Official TS SDK v2, `@modelcontextprotocol/server` over stdio | PRD section 9 | Pin the exact version. Re-check the SDK README at each milestone because it moves fast. |
| SQLite driver | `node:sqlite` (built in, no native build) | Zero install friction, zero cost | `better-sqlite3` if `node:sqlite` is still flagged experimental or missing features on the pinned Node version |
| TS/JS parser | TypeScript compiler API (`typescript` package) | Real symbol and re-export resolution | tree-sitter only if TS parsing proves too slow on large repos |
| Python parser | tree-sitter via WASM (`web-tree-sitter` plus the Python grammar) | No native build, no Python subprocess (C3), runs offline | A pure-JS Python parser if the WASM build causes install problems |
| Schema | Zod | PRD section 5. One schema produces both TS types and JSON Schema for MCP. | none |
| Tests | Vitest | Fast | none |
| Lint | ESLint with a custom `no-restricted-imports` rule for fs-write and child_process | Supports C3 | none |
| Package manager | npm | Lowest friction for users installing via `npx` | none |
| CI | GitHub Actions (`.github/workflows/ci.yml`): typecheck, lint, the full test suite, build, and the spine and skills checks on every push and PR; Linux and macOS block, Windows is experimental. Dependabot opens weekly update PRs (D23) | Gates 1 and 2 run on every change, not only when someone remembers; exact pins don't go stale silently | Run the same commands locally before every merge |
| Licence | Apache-2.0 | Patent grant; the licence larger companies approve most easily | none |
| Name | Working name `migration-planner-mcp` | MCP is now one adapter, so the final name drops it | Decided in M10, before publish |

## Per-milestone gates (PRD section 12)

Every milestone is done only when all of these hold:

1. `npm test` passes, including `test/permissions/` (this suite is never skipped).
2. `npm run typecheck` and `npm run lint` pass.
3. The eval smoke set passes. Before M7 this is the seeded fixture repo. From M7 on it is `npm run eval:smoke`.
4. The target-repo hash is unchanged after the demo command (`scripts/repo-hash.ts`, added in M1).
5. **Independent review:** a separate agent session sees only the milestone plan file and the diff, not the builder's reasoning, and signs off against the acceptance criteria. It removes each guard the milestone adds, one at a time, and confirms a test fails (the mutation check). Findings are "must fix" (an unmet criterion, a broken constraint or gate, a guard no test catches) or "noticed", and only "must fix" blocks. The review takes at most 2 rounds; "must fix" items still open after round 2 go to the user as decisions (`docs/design.md` D19).
6. **Summary for the user:** the reviewer ends with a plain-language summary of about 10 lines: what was built, which guard protects each rule and which test proves it, and any decision the user must make. The user reads it before the next milestone starts. The `quiz-me` quiz is optional, on request (D19).
7. Spine docs are updated: new invariants, new failure-mode rows and new design decisions.

## Target source layout (PRD section 13)

```
src/
  core/                     # engine API: every adapter calls these functions, nothing else
  cli/                      # CLI adapter: one command per tool, flags --out, --level, --db, --sandbox
  server.ts                 # MCP stdio adapter: tool/prompt/resource registration
  tools/                    # one file per MCP tool; thin, validate input -> call core
  lang/                     # ts/ (TypeScript compiler API), python/ (tree-sitter WASM); one LanguageAdapter interface
  analysis/                 # scanner, usage adapters per pack, risk signals, sizing (deterministic)
  rules/                    # loader.ts, versions.ts, compose.ts (knowledge loading, version schemes, range composition)
  pipeline/                 # ingest.ts, packets.ts, aggregate.ts, gates/*.ts, emit.ts, routing.ts, report.ts
  verify/                   # sandbox.ts, loop.ts, testIntegrity.ts (gate 7), codemods.ts (registry)
  security/                 # pathBoundary.ts, denyList.ts, level.ts, safeWrite.ts, exec.ts, network.ts
  schema/                   # finding.ts, plan.ts, knowledge.ts, pack.ts, match.ts, scope.ts, events.ts, verify.ts
  store/                    # db.ts, migrations/, campaigns.ts, events.ts, usages.ts, docs.ts
  docs/                     # context7.ts, cache.ts, officialUrl.ts (shared URL check, M3)
knowledge/<ecosystem>/<library>/   # library.json, CHANGELOG.md, releases/<release>.json (facts per release; source of truth)
packs/<pack>/               # pack.json (which libraries, how to plan), CHANGELOG.md, generated SKILL.md, references/
prompts/                    # plan_migration.v1.md (+ later versions, never overwritten)
eval/                       # cases/, seeded/, baseline/, runs/ (recorded runs), dryruns/ (M5 dry run), history/, runner.ts, results.md
examples/AGENTS.snippet.md
test/                       # unit/, permissions/, fixtures/
```

## M11 - Publish (after M10, not given its own plan here)

Publish to npm under the name chosen in M10, tag `v0.1.0`, and check the `npx` install on a clean machine or container, for both the CLI and the MCP config. Publish the Claude Code plugin bundle. Only once real eval numbers exist does the README change from "currently building".
