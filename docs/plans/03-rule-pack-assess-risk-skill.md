# M3 - Rule pack, get_rule_pack, assess_risk, short skill with references

**PRD refs:** sections 2 (retrieval rows), 9 (skills, and the rule-pack trust model), 8 (Rule packs and skills row), 11. **Done when:** the pack and SKILL.md are generated from one source and the skill lint passes.

## Scope

- In scope:
  - the Express to Hono rule pack as data
  - a pack schema and loader
  - `get_rule_pack`
  - a deterministic `assess_risk`
  - a generator that builds `SKILL.md` and the `references/` files from the pack source
  - the skill and pack lint in CI
- Out of scope: Context7 (M4), producing findings (M5), and third-party packs (not supported in v0.1).

## Tasks

1. **Pack schema (`src/schema/rulePack.ts`, Zod).**
   - Fields: `name`, `version` (semver), `source {library, range}`, `target {library, range}`, `trigger` (a single sentence), `rules[]`, `references[]`.
   - Each rule has: `id`, `usage_kinds[]` (links to M2 kinds), `symbol_pattern`, `concern`, `default_severity`, `mapping` (from and to text), `no_equivalent` (bool), `notes`, `doc_hints[]` (library and topic strings for M4, not URLs), `verify_hint` and `rollback_hint`.
   - **No executable fields.** The schema rejects unknown keys. A lint check also rejects strings that look like shell commands in non-`verify_hint` fields, and `verify_hint` is display text only (C3).
2. **Express to Hono source (`rules/express-to-hono/rules.json`, `CHANGELOG.md`, `references-src/*.md`).** Rules should cover at least:
   - app and router creation
   - route methods and params (`:id` syntax and `c.req.param`)
   - `req.body` and body parsing (`c.req.json()`, async)
   - `res.json/send/status/redirect` mapped to `c.json/c.text/c.status/c.redirect`
   - middleware signature (`next()` vs `await next()`)
   - error middleware (`app.onError`)
   - 404 handling (`app.notFound`)
   - static files (adapter-specific `serveStatic`)
   - streaming (`hono/streaming`)
   - `res.locals` mapped to `c.set/c.get`
   - `app.listen` mapped to a runtime adapter (`@hono/node-server`)
   - `trust proxy` and `req.ip`
   - cookies (`hono/cookie`)
   - CORS and third-party middleware equivalents (`hono/cors`, plus an explicit `no_equivalent: true` for unmapped ones such as `multer` and `passport`)
   - types (`Request`/`Response` mapped to `Context`)

   **Write every mapping against the current Hono docs**, and record the doc page in `doc_hints`. These are verified again via Context7 in M4.
3. **Generator (`scripts/build-pack.ts`).** Reads `rules.json` and `references-src/` and writes:
   - `rules/express-to-hono/SKILL.md`, at most about 100 lines. Frontmatter `name` and `description`, where description = the trigger sentence: "Use when planning an Express to Hono migration in a TypeScript repo." The body is the steps, the tool order (`scan_repo` → `find_usages` → `get_rule_pack` → `assess_risk` → `get_migration_docs` → `plan_migration` → `merge_findings` → `validate_plan`), the output contract (the finding schema by name, not inline) and pointers to the references. No API tables inline.
   - `rules/express-to-hono/references/{breaking-changes,middleware-mappings,streaming,error-handling}.md`, generated from the rule entries, each with a header that names the pack version.
   - Generated files carry a "do not edit; generated from rules.json vX.Y.Z" banner. CI regenerates them and fails on a diff, which is the drift check.
4. **Skill and pack lint (`scripts/lint-packs.ts`, run in `npm run lint` and CI).** It fails on:
   - a missing or overly broad trigger. The description must name both libraries and contain "Use when", and a blocklist rejects phrases like "working with backends" and "any".
   - SKILL.md over the line limit
   - a reference link to a file that does not exist
   - a pack version not bumped while rules changed (compared with git HEAD in CI)
   - a missing CHANGELOG entry for the current version
   - any file in the pack dir other than `.json` or `.md` (no scripts)
5. **Pack loader (`src/rules/loader.ts`).** Loads packs only from the repo's bundled `rules/` dir in v0.1 and validates them with Zod. A `--rules-dir` pointing anywhere else is refused with "third-party packs not supported in v0.1". At server start it logs the pack name, version and content hash to stderr. Every run records `pack_name@version#hash` in `runs.versions_json`.
6. **`get_rule_pack` tool.** Input is `run_id`, or `source` and `target`. It returns the pack version, the rules (optionally filtered to usage kinds present in the run) and the reference file paths as MCP resources, so the agent loads them only on demand (progressive disclosure).
7. **`assess_risk` tool (`src/analysis/risk.ts`, deterministic, no LLM).** For each usage in the run it computes signals:
   - whether a matched rule exists, and the rule's default severity
   - `no_equivalent`
   - indirect via re-export depth
   - heuristic match confidence
   - fan-in (how many files import the module containing the usage)
   - whether the file is an entrypoint
   - whether there is a test file covering the module (by import graph)
   - async/sync signature change (middleware `next`)
   - streaming or `res` mutation

   It outputs `risk_signals[]` and a computed `suggested_severity` with an explanation per signal. Usages that match no rule are flagged as `unmapped`, which is an input for the M5 lenses and gate 2.

## Files and modules

`src/schema/rulePack.ts`, `src/rules/loader.ts`, `src/tools/{getRulePack,assessRisk}.ts`, `src/analysis/risk.ts`, `rules/express-to-hono/{rules.json,CHANGELOG.md,SKILL.md,references/*,references-src/*}`, `scripts/{build-pack,lint-packs}.ts`, `test/unit/{rulePack,risk,lintPacks}.test.ts`.

## Tests

- **Schema:** rejects unknown keys, a missing trigger and an executable-looking field.
- **Lint:** one failing fixture per lint rule (an overly broad trigger, 150 lines, a missing reference, a `.sh` file in the pack, an unbumped version).
- **Generator:** golden-file test, so the same input gives byte-identical output.
- **Risk:** a table-driven test of the signals on the `express-tricky` seeded repo. Streaming, error middleware and `multer` must come out at `high` or `blocker` suggested severity.
- **Loader:** `--rules-dir` outside the bundled dir is refused, and the pack version appears in the run record.
- **Permissions:** the full suite still passes.

## Acceptance criteria

- `npm run build:packs` regenerates SKILL.md and references with zero diff, and editing `rules.json` without regenerating fails CI.
- SKILL.md is at most 100 lines and has a narrow trigger. The lint passes.
- `assess_risk` on the seeded repo flags every planted hard case at `medium` or above, with signal explanations.
- The pack name, version and hash are printed at startup and recorded per run.

## Risks

- **The rule pack is wrong or out of date, which is a supply-chain risk to plan quality.** Mitigation: version and changelog, PR review, rule re-verification against Context7 in M4, and from M7 a golden-set rerun on every pack change.
- **A skill trigger that is too broad loads on unrelated tasks.** Mitigation: the lint blocklist plus a manual check in Cursor and Claude Code that the skill does not trigger on a generic backend question.
- **Over-tuned risk heuristics.** Mitigation: keep the signals explainable, and tune the weights only from M7 eval data.

## Dependencies

- M2: usage kinds, the usage index and the import graph (for fan-in and test coverage).

## Must not break

The `find_usages` output and recall ratchet, the permissions suite and the repo hash.
