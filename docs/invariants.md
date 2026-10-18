# Invariants

Numbered rules that must always hold. Each names the test that fails when the rule breaks. Numbers are never reused: a removed rule is marked `retired` with the reason, not deleted.

**M0 note.** No code exists yet, so the test files named below are *planned* paths from the milestone plans, not existing files. The milestone that adds each guard also adds its test and flips the invariant from planned to live. An invariant without a passing test is not satisfied; it is a promise the milestone must keep.

## Permissions and path boundary (C3–C6, C9, C10)

- **INV-1:** The user's target repo is never written, at any level. The engine only writes under `--out` (default `.migration-planner/`, outside the source tree), and refuses to start if `--out` resolves inside the repo. *(planned: `test/permissions/no-repo-write.test.ts`, `scripts/repo-hash.ts` unchanged before/after a run — M1, M8)* — C3
- **INV-2:** `src/security/safeWrite.ts` is the only module that writes files; `src/security/exec.ts` is the only module that spawns a process. A lint rule (`no-restricted-imports` on `node:fs` write APIs and `node:child_process`) enforces this. *(planned: `test/permissions/single-write-point.test.ts`, `test/permissions/single-spawn-point.test.ts`, ESLint rule — M1, M8)* — C3
- **INV-3:** No execution at L0 (the default). The `verify` field is text only. *(planned: `test/permissions/no-exec-at-l0.test.ts` — M1, M8)* — C3, C5
- **INV-4:** Path boundary: every read goes through `resolveInside(root, p)`, which realpaths both sides and rejects `..`, absolute paths outside the root, and symlink escapes. *(planned: `test/permissions/path-boundary.test.ts` — M1)* — C4
- **INV-5:** Deny-listed files (`.env*`, keys, `.npmrc`, `.pypirc`, user denies) are never read. The AGENTS.md snippet can only *add* deny entries, never remove them. *(planned: `test/permissions/deny-list.test.ts` — M1)* — C4
- **INV-6:** Autonomy is opt-in. L0 is the default; L1 needs `--level 1`; `--level 2` is refused as "not built in v0.1". A tool argument can never raise the level. *(planned: `test/permissions/level.test.ts` — M1, M8)* — C5
- **INV-7:** In L1, `cwd` for every spawned process is inside `<out>/<run_id>/sandbox`, the child environment is scrubbed to an allowlist, every command has a timeout, and the sandbox is a `git clone --no-hardlinks` of the repo. *(planned: `test/permissions/sandbox-cwd.test.ts`, `test/permissions/env-scrub.test.ts` — M8)* — C3, C5
- **INV-8:** Commands run in L1 come only from user-owned config (CLI flags or the AGENTS.md snippet with `--trust-repo-checks`) or the pinned codemod allowlist. Never from tool arguments, packs, prompts or the agent. *(planned: `test/permissions/command-source.test.ts` — M8)* — C9
- **INV-9:** Codemods come only from the core allowlist in `src/verify/codemods.ts`, each at a pinned version. Knowledge and packs name a codemod by ID only. *(planned: `test/permissions/codemod-allowlist.test.ts` — M8)* — C9
- **INV-10:** Pack and knowledge data never execute. The knowledge and pack schemas reject unknown keys and command-like fields, and the pack lint rejects shell-like strings outside the display-text fields and any file under `knowledge/` or `packs/` that isn't JSON or Markdown. *(planned: `test/unit/knowledge.test.ts`, `test/unit/pack.test.ts`, `test/unit/lintPacks.test.ts` — M3)* — C9
- **INV-11:** The engine's only outbound network is Context7, only when configured, carrying a typed payload of library names, versions and symbol names — never repo contents. No telemetry. *(planned: `test/unit/context7-payload.test.ts` — M4)* — C6
- **INV-12:** Storage is SQLite (`node:sqlite`, falling back to `better-sqlite3`) plus plain files, all through `src/store/`. No vector DB. *(planned: `test/unit/store-only.test.ts` — M1)* — C2
- **INV-13:** Runs, usages, findings and evidence carry a `repo_id` under a `campaign_id`. A request naming more than one repo is refused with "not built in v0.1". *(planned: `test/unit/single-repo-refusal.test.ts` — M1)* — C10
- **INV-14:** stdout is the MCP protocol channel; logs and startup banners go to stderr. *(planned: `test/unit/stdout-protocol-only.test.ts` — M1)* — C1

## Gates (deterministic, no LLM)

Gates 1–6 run on the plan in `validate_plan`; gate 7 runs on each L1 stage patch. All gates re-check against real files and import no network or model code. After 3 rounds/attempts, failures go to `unresolved[]` and are never marked passed.

- **INV-15 (gate 1):** Every evidence location exists and its `snippet_hash` matches the current file, via the one shared normaliser. *(planned: `src/pipeline/gates/g1-evidence.ts`, `test/unit/gates/` `bad-g1` fixture — M6)*
- **INV-16 (gate 2):** Every usage found by `find_usages` is covered by a finding or explicitly marked out of scope with a reason. *(planned: `src/pipeline/gates/g2-coverage.ts`, `test/unit/gates/` `bad-g2` fixture — M6)*
- **INV-17 (gate 3):** Every `doc_refs` entry came from the docs tool in this run; no invented links. *(planned: `src/pipeline/gates/g3-doc-refs.ts`, `test/unit/gates/` `bad-g3` fixture — M6)*
- **INV-18 (gate 4):** Every finding with severity `high` or `blocker` has a rollback and a verify step. *(planned: `src/pipeline/gates/g4-rollback-verify.ts`, `test/unit/gates/` `bad-g4` fixture — M6)*
- **INV-19 (gate 5):** Stage order is valid: no stage depends on a change that comes later, checked against the import graph. *(planned: `src/pipeline/gates/g5-stage-order.ts`, `test/unit/gates/` `bad-g5` fixture — M6)*
- **INV-20 (gate 6):** The plan is schema-valid with no duplicate finding IDs. *(planned: `src/pipeline/gates/g6-schema-ids.ts`, `test/unit/gates/` `bad-g6` fixture — M6)*
- **INV-21 (gate 7, test integrity):** Compared with the sandbox before the stage, an L1 patch must not reduce the number of test cases or assertions, add `skip`/`only`/`todo`/`xfail` markers, delete test files or snapshots, lower coverage thresholds, or edit check definitions. A stage needing any of these goes to "Review first", never into a kept patch silently. *(planned: `src/verify/testIntegrity.ts`, `test/unit/gate7-*.test.ts`, weakened-test fixtures all rejected — M8)*

## Output and honesty

- **INV-22:** A finding with `source = agent_judgment` and no evidence is rejected (not merely down-ranked). *(planned: `test/unit/finding-schema.test.ts` — M5)* — PRD §5
- **INV-23:** Prompts are versioned files (`prompts/plan_migration.vN.md`); a released version is never overwritten, only a new version added. *(planned: `test/unit/prompt-versioning.test.ts` / lint — M5)*
- **INV-24:** Pack `SKILL.md` and `references/` are generated from `packs/<pack>/pack.json` and the knowledge it uses, with a "do not edit" banner; CI fails on drift. *(planned: `test/unit/pack-gen-drift.test.ts` / `npm run build:packs` check — M3)*
- **INV-25:** From M7, any change under `prompts/`, `knowledge/`, `packs/`, `src/rules/`, `src/analysis/`, `src/pipeline/{aggregate,packets,routing}.ts`, `src/pipeline/gates/` or `src/verify/` regenerates `eval/results.md` in the same change (the regression rule). *(planned: CI check — M7)*
- **INV-26:** The README says "currently building" until v0.1 ships (M11) with real eval numbers. *(planned: M10 review check)* — C8
- **INV-27:** Adding a pack touches only an allowlist of paths: the pack's knowledge and pack folders, one new usage adapter and its registry line, eval data, tests and docs. Everything else, including `scripts/` and the eval scoring code, is protected. *(planned: `scripts/check-core-untouched.ts` — M10)*

## Coverage and staging (added after the M0 review; see `design.md` D5–D7)

- **INV-28:** Every reviewed rule reachable in a pack's supported range has at least one `expect: change` seeded case in that pack, and every code-usage kind has an indirect seeded entry. (Revised by D10: `lands_on` is derived, not a field.) *(planned: `scripts/lint-packs.ts`, `test/unit/lintPacks.test.ts` — M3)*
- **INV-29:** No prep stage depends on the version-bump stage, and no `lands_on: target` finding (including any finding with no matched rule) is staged before it. *(planned: `src/pipeline/gates/g5-stage-order.ts`, `test/unit/gates/` `bad-g5` fixture — M6)*
- **INV-30:** Eval headline metrics are computed from raw truth only. `annotations.json` entries add an adjusted figure and a "PR missed" list, never change the headline. *(planned: `test/unit/eval/` annotations test — M7)*
- **INV-31:** A finding that proposes a change on a seeded `no_change` or `no_finding` entry counts as a false alarm. *(planned: `test/unit/eval/` seeded-precision test — M7)*

## Sizing, scope and doc sources (see `design.md` D8, D9)

- **INV-32:** The size is `none` only when the scan is complete (no unparsed files, unresolved dynamic imports or size-limit skips), zero usages match a rule, no dependency has a peer conflict, and the installed version is not older than the knowledge's `covered_from` or the pack's `supported.from`. A `none` plan still lists the pack's behaviour changes, and every usage found in it has an engine-written out-of-scope reason. *(planned: `test/unit/sizing.test.ts` — M3)*
- **INV-33:** Scope only narrows. `set_scope` accepts only offered option IDs, cannot change the paths, the deny list, the level, the checks or `--out`, can only move `depth` toward `full`, and is refused once the first lens packet is fetched or `merge_findings` has run, whichever comes first. *(planned: `test/permissions/scope-cannot-widen.test.ts`, `test/unit/scope.test.ts` — M3)* — C4, C5, C9
- **INV-34:** Every usage the scope excluded, whose rule has `necessity: breaks`, appears in "Review first". *(planned: `test/unit/routing.test.ts` — M9)*
- **INV-35:** Every doc a run uses, including fallback links, records `fetched_by` (`engine`, `agent` or `knowledge`) and `official`, and has a `doc_id` in `run_docs`. An agent-registered doc whose URL is outside the `doc_sources` prefixes of the pack's libraries is never shown as verified, and findings citing only such docs carry the "docs unverified" badge. *(planned: `test/unit/docs/source-labels.test.ts` — M4)* — gate 3 support

## Knowledge, composition and maintainer tools (see `design.md` D10, D11)

- **INV-36:** Only `reviewed` rules load. Drafts are skipped and counted, never composed, sized or cited. *(planned: `test/unit/knowledge.test.ts`, loader test — M3)*
- **INV-37:** For installed version S and target T, a rule applies only when it has an event in (S, T]. `necessity` and `lands_on` are derived from its events and `replacement_since`, never read from a field, and are identical for `semver` and `pep440` on equivalent inputs. *(planned: `test/unit/compose.test.ts` — M3)*
- **INV-38:** Pre-release versions are refused at ingest and in composition, and a target whose release unit is newer than the pack's `supported.to` is refused at ingest; a patch release inside `supported.to` is accepted. *(planned: `test/unit/versions.test.ts`, `test/unit/ingest.test.ts` — M3)*
- **INV-39:** Every reviewed rule reachable in a pack's supported range uses a match kind the pack's usage adapter declares, and its `source` is under one of its library's `doc_sources`. *(planned: `scripts/lint-packs.ts`, `test/unit/lintPacks.test.ts` — M3)*
- **INV-40:** Nothing under `src/` imports from `scripts/`, so maintainer tools that use the network stay outside the engine (C6). *(planned: import lint, `test/permissions/` — M3)* — C6
- **INV-41:** Maintainer tools never commit a decision. The drafter only writes `draft` rules and never overwrites a reviewed one, and the golden-case finder only writes to `eval/.work/candidates/`. *(planned: `test/unit/` drafter and finder tests on recorded fixtures — M3, M7)*
