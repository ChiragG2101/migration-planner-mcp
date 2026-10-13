# 00 - Implementation plan overview

This folder turns [`docs/PRD.md`](../PRD.md) (v3) into milestone plans. It is a plan, not an implementation. Each milestone file (`01` to `09`, matching M1 to M9) lists its scope, tasks, files and modules, tests, acceptance criteria, risks and dependencies.

## Non-negotiable constraints (apply to every milestone)

These come from PRD sections 1, 3 and 7A. A milestone that breaks one of them is not done, whatever else it ships.

| ID | Constraint | How it is enforced |
| --- | --- | --- |
| C1 | **Local-first, zero cost.** stdio transport only. No servers, no hosted services, no paid APIs. Context7 is optional and works on its free tier or with no key at all. | No HTTP listener in `src/`. Dependency review at every milestone. The server must run fully offline (Context7 falls back to the cache, see M4). |
| C2 | **SQLite plus plain files** is the only storage. No vector DB, Postgres or Redis. | One store module (`src/store/`). Everything else goes through it. |
| C3 | **Read-only by default (L0).** The server never writes inside the target repo and never executes its scripts, tests or install commands. | `src/security/` is the only module allowed to import `node:fs` write APIs or `node:child_process`. A lint rule and the permissions suite check this (see M1). |
| C4 | **Path boundary.** Every path is resolved against the ingest root. `..`, absolute paths outside the root and symlink escapes are rejected. Deny-listed files (`.env*`, keys, user denies) are never read. | `security/pathBoundary.ts` plus `security/denyList.ts`, tested in `test/permissions/`. |
| C5 | **Autonomy is opt-in.** L0 is the default. L1 needs `--level 1`. L2 is not built in v0.1. | `security/level.ts`. Every write path checks the level first. |
| C6 | **Network allowlist.** Only Context7, and only when configured. No telemetry. Only library names, versions and API symbol names are sent; repo contents never leave the machine. | `src/docs/context7.ts` is the only network module, and it takes a typed payload with no free-text field. A test asserts the outbound payload shape. |
| C7 | **The host agent is the LLM.** No MCP sampling. The server is deterministic. | No LLM SDK dependency in the server core. The optional CLI mode is a separate entrypoint and is out of scope for M1 to M9. |
| C8 | **Honest claims.** The README says "currently building" until real eval numbers exist. | Checked as part of the M9 review. |

## Milestone map

| # | Plan file | Deliverable (PRD section 12) | Depends on |
| --- | --- | --- | --- |
| M0 | (this file, section below) | `docs/failure-modes.md`, `docs/invariants.md`, 3 golden cases chosen | none |
| M1 | [`01-mcp-skeleton-scan-repo-permissions.md`](01-mcp-skeleton-scan-repo-permissions.md) | MCP skeleton, `scan_repo`, event log, path boundary, read-only rule | M0 |
| M2 | [`02-find-usages-express.md`](02-find-usages-express.md) | `find_usages` for Express, usage index | M1 |
| M3 | [`03-rule-pack-assess-risk-skill.md`](03-rule-pack-assess-risk-skill.md) | Rule pack, `get_rule_pack`, `assess_risk`, short skill with references | M2 |
| M4 | [`04-context7-docs-cache.md`](04-context7-docs-cache.md) | Context7 integration, retrieval log, cache | M1 (M3 for the fallback content) |
| M5 | [`05-finding-schema-prompt-lenses.md`](05-finding-schema-prompt-lenses.md) | Finding schema, `plan_migration` prompt, four lenses | M2, M3, M4 |
| M6 | [`06-merge-findings-validate-plan.md`](06-merge-findings-validate-plan.md) | `merge_findings`, `validate_plan` gates | M5 |
| M7 | [`07-eval-runner-golden-baseline.md`](07-eval-runner-golden-baseline.md) | Eval runner, 5 golden cases, baseline run | M6 |
| M8 | [`08-confidence-feedback-report-levels.md`](08-confidence-feedback-report-levels.md) | Confidence routing, `record_feedback`, run report, L1 behind `--level 1` | M6, M7 |
| M9 | [`09-jest-vitest-readme-agents-demo.md`](09-jest-vitest-readme-agents-demo.md) | Jest to Vitest pack, README, AGENTS.md snippet, demo | M3, M7, M8 |
| M10 | (this file, section below) | npm publish, tag v0.1 | M9 |

M4 can run in parallel with M2 and M3 once M1 lands. Everything else runs in order.

**Cut order if behind (PRD section 12):** L1 output (M8), then the second migration (M9), then server-side Context7 (a stretch goal anyway), then CLI mode. **Never cut** the gates (M6), the permissions rules (M1 and every later milestone) or the eval (M7).

## M0 - Spine docs and golden cases (pre-code)

- **Scope:** write the spine files and pick the eval cases before writing code (PRD sections 8, 10 and 12).
- **Tasks:**
  1. `docs/design.md`: a copy of or link to the PRD, plus decisions taken during the build. The SDK and SQLite choices below are the first entries.
  2. `docs/invariants.md`: numbered invariants, each with the test that proves it, for example "INV-1: the target repo is never written (test/permissions/no-repo-write.test.ts)". It starts with C3 to C6 and the 6 gates.
  3. `docs/failure-modes.md`: the PRD section 8 matrix, with a "test or check" column added.
  4. `plan.md` at the repo root: a short milestone checklist that links here.
  5. Find at least 3 public Express to Hono migration PRs (the target is 5 to 8 by M7, including one messy or failed migration). Record the repo URL, base commit, merge commit and PR URL in `eval/cases/README.md`.
- **Acceptance:** all files exist, and each golden case has a pinned base commit that can be checked out.
- **Risk:** good migrations are hard to find (PRD section 16). Start this search now. Candidate sources: GitHub code search for `from 'hono'` in commits that remove `express`, and the Hono discussions and showcase pages.

## Cross-cutting technical decisions (confirm in M1, record in `docs/design.md`)

| Decision | Default | Why | Fallback |
| --- | --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript strict, ESM | Matches the MCP TS SDK and the TypeScript compiler API | none |
| MCP SDK | Official TS SDK v2, `@modelcontextprotocol/server` over stdio | PRD section 9 | Pin the exact version. Re-check the SDK README at each milestone because it moves fast. |
| SQLite driver | `node:sqlite` (built in, no native build) | Zero install friction, zero cost | `better-sqlite3` if `node:sqlite` is still flagged experimental or missing features on the pinned Node version |
| Parser | TypeScript compiler API (`typescript` package) | Real symbol and re-export resolution | tree-sitter only if TS parsing proves too slow on large repos |
| Schema | Zod | PRD section 5. One schema produces both TS types and JSON Schema for MCP. | none |
| Tests | Vitest | Fast. The project also dogfoods the Jest to Vitest pack later. | none |
| Lint | ESLint with a custom `no-restricted-imports` rule for fs-write and child_process | Supports C3 | none |
| Package manager | npm | Lowest friction for users installing via `npx` | none |

## Per-milestone gates (PRD section 12)

Every milestone is done only when all of these hold:

1. `npm test` passes, including `test/permissions/` (this suite is never skipped).
2. `npm run typecheck` and `npm run lint` pass.
3. The eval smoke set passes. Before M7 this is the seeded fixture repo. From M7 on it is `npm run eval:smoke`.
4. The target-repo hash is unchanged after the demo command (`scripts/repo-hash.ts`, added in M1).
5. **Independent review:** a separate agent session sees only the milestone plan file and the diff, not the builder's reasoning, and signs off against the acceptance criteria.
6. **Comprehension check:** the builder answers an agent-generated quiz on the new code before starting the next milestone.
7. Spine docs are updated: new invariants, new failure-mode rows and new design decisions.

## Target source layout (PRD section 13)

```
src/
  server.ts                 # MCP stdio entrypoint, tool/prompt/resource registration
  cli.ts                    # flags: --out, --level, --rules-dir (no execution of target repo)
  tools/                    # one file per MCP tool; thin, validate input -> call pipeline
  analysis/                 # scanner, usage finder, risk signals (deterministic)
  pipeline/                 # ingest.ts, aggregate.ts, gates/*.ts, emit.ts, routing.ts
  security/                 # pathBoundary.ts, denyList.ts, level.ts, safeWrite.ts
  schema/                   # finding.ts, plan.ts, rulePack.ts, events.ts
  store/                    # db.ts, migrations/, events.ts, usages.ts, docs.ts
  docs/                     # context7.ts, cache.ts
rules/<pack>/               # rules.json (source of truth), CHANGELOG.md, generated SKILL.md, references/
prompts/                    # plan_migration.v1.md (+ later versions, never overwritten)
eval/                       # cases/, seeded/, baseline/, runner.ts, results.md
examples/AGENTS.snippet.md
test/                       # unit/, permissions/, fixtures/
```

## M10 - Publish (after M9, not given its own plan here)

Publish to npm as `migration-planner-mcp`, tag `v0.1.0`, and check the `npx` install on a clean machine or container. Only once real eval numbers exist does the README change from "currently building". Any outreach then follows PRD section 15.
