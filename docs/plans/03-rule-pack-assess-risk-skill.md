# M3 - Pack schema, Next.js pack, get_rule_pack, assess_risk, generated skill

**PRD refs:** sections 2 (retrieval rows), 9 (skills, pack shape and trust model), 8 (Rule packs and skills row), 11. **Done when:** the pack and SKILL.md are generated from one source and the skill lint passes.

## Scope

- In scope:
  - a pack schema that covers both pack kinds (`upgrade` and `swap`) and codemod references
  - the Next.js major-upgrade pack as data
  - a pack loader
  - `get_rule_pack`
  - a deterministic `assess_risk`
  - sizing and scope: `propose_scope` and `set_scope` (PRD section 2, `docs/design.md` D8)
  - a generator that builds `SKILL.md` and the `references/` files from the pack source
  - the skill and pack lint in CI
- Out of scope: Context7 (M4), producing findings (M5), running codemods (M8; this milestone only references them), the Django pack (M10) and third-party packs (not supported in v0.1).

## Tasks

1. **Pack schema (`src/schema/rulePack.ts`, Zod).**
   - Fields: `name`, `version` (semver), `kind` (`upgrade` or `swap`), `source {library, range}`, `target {library, range}` (for `upgrade`, the same library with two ranges), `languages[]`, `trigger` (a single sentence), `usage_kinds[] {kind, lens}` (which M5 lens receives each usage kind), `staging` (`leaf_first` or `config_first`, read by the M6 aggregator), `rules[]`, `codemods[]`, `checks_hint`, `references[]`.
   - Each rule has: `id`, `usage_kinds[]` (links to M2 kinds), `symbol_pattern`, `concern`, `default_severity`, `mapping` (from and to text), `no_equivalent` (bool), `codemod?` (an ID from `codemods[]`), `notes`, `doc_hints[]` (library and topic strings for M4, not URLs), `verify_hint`, `rollback_hint`, `lands_on` and `necessity`.
   - `necessity` is `breaks` (the target removes or changes it, so the code fails or behaves differently) or `deprecated` (it still works on the target but warns, and a later major removes it). Sizing and the scope questions read it.
   - `lands_on` is `source` or `target`. `source` means the fix also works on the source version, so it can land and be verified *before* the version bump (Django's own advice: clear the deprecation warnings first). `target` means it only works after the bump. The M6 aggregator reads it for staging (`docs/design.md` D5).
   - `codemods[]` entries are `{ id, covers_rules[], notes }`. The `id` must exist in the core codemod registry (M8 implements the registry; M3 ships its ID list as data in `src/verify/codemodIds.ts` so the lint can check references now). A pack can never supply a command, binary name, package name or arguments.
   - `checks_hint`: display text that suggests which checks a user should declare (for example "typecheck, build, unit tests"). Never executed.
   - **No executable fields.** The schema rejects unknown keys. A lint check also rejects strings that look like shell commands in any field other than `verify_hint` and `checks_hint`, and both of those are display text only (C3, C9).
2. **Next.js pack (`rules/nextjs-upgrade/rules.json`, `CHANGELOG.md`, `references-src/*.md`).**
   - Kind `upgrade`, library `next` plus the required `react` and `react-dom` changes. The `from` and `to` ranges are fixed at the start of M3 against the current Next.js release and upgrade guide, and recorded in the changelog with the date.
   - Rules cover each usage kind from M2: async request APIs, caching and segment config, config keys, removed or renamed packages, the React changes the Next.js major requires, peer-dependency conflicts, and type changes.
   - Rules cover the breaking changes and removals of **every** release in the `from` to `to` range, not only the target major. A range starting one major earlier includes that major's removals too, because repos that skipped a cleanup still carry the code.
   - Every rule has at least one seeded case. M3 adds `rule_id` to the `next-tricky` ground-truth entries and plants a case for any rule that has none.
   - Codemod references: the official `@next/codemod` transforms that cover rules (for example the async request API transform and the upgrade command), and React's official codemods where they apply. Each reference names which rules it covers, so the plan can show what the codemod leaves for manual work.
   - **Write every mapping against the current Next.js and React docs**, and record the doc page in `doc_hints`. These are verified again via Context7 in M4. Nothing is written from memory.
3. **Generator (`scripts/build-pack.ts`).** Reads `rules.json` and `references-src/` and writes:
   - `rules/nextjs-upgrade/SKILL.md`, at most about 100 lines. Frontmatter `name` and `description`, where description = the trigger sentence: "Use when planning a Next.js major version upgrade in a TypeScript or JavaScript repo." The body is the steps, the tool order (`scan_repo` → `find_usages` → `get_rule_pack` → `assess_risk` → `propose_scope` → ask the user → `set_scope` → `get_migration_docs` → `plan_migration` → `merge_findings` → `validate_plan` → `emit_plan`, then at L1 `verify_stage`), the output contract (the finding schema by name, not inline) and pointers to the references. No API tables inline.
   - `rules/nextjs-upgrade/references/{breaking-changes,async-request-apis,caching,react-changes,codemods}.md`, generated from the rule entries, each with a header that names the pack version.
   - Generated files carry a "do not edit; generated from rules.json vX.Y.Z" banner. CI regenerates them and fails on a diff, which is the drift check.
4. **Skill and pack lint (`scripts/lint-packs.ts`, run in `npm run lint` and CI).** It fails on:
   - a missing or overly broad trigger. The description must name the library and the migration, and contain "Use when", and a blocklist rejects phrases like "working with React" and "any".
   - SKILL.md over the line limit
   - a reference link to a file that does not exist
   - a codemod reference whose ID is not in the core registry list, or a rule pointing at a codemod not in the pack's `codemods[]`
   - a pack version not bumped while rules changed (compared with git HEAD in CI)
   - a missing CHANGELOG entry for the current version
   - a rule with no seeded case: every rule `id` must be the `rule_id` of at least one `expect: change` entry in the pack's seeded `ground_truth.json`
   - a code-usage kind (calls and imports, not config keys or dependency ranges) with no indirect seeded entry (through a helper, wrapper or re-export)
   - a rule with no `lands_on` or no `necessity`
   - any file in the pack dir other than `.json` or `.md` (no scripts)
5. **Pack loader (`src/rules/loader.ts`).** Loads packs only from the repo's bundled `rules/` dir in v0.1 and validates them with Zod. A `--rules-dir` pointing anywhere else is refused with "third-party packs not supported in v0.1". At startup it logs the pack name, version and content hash to stderr. Every run records `pack_name@version#hash` in `runs.versions_json`.
6. **`get_rule_pack` (core, tool and CLI `pack`).** Input is `run_id`, or `source` and `target`. It returns the pack version, the rules (optionally filtered to usage kinds present in the run), the codemod references with the rules they cover, and the reference file paths as MCP resources, so the agent loads them only on demand (progressive disclosure).
7. **`assess_risk` (`src/analysis/risk.ts`, core, tool and CLI `risk`; deterministic, no LLM).** For each usage in the run it computes signals:
   - whether a matched rule exists, and the rule's default severity
   - whether a codemod covers the rule (lower risk for the mechanical part, but the usage still needs a verify step)
   - `no_equivalent`
   - indirect via re-export depth
   - heuristic match confidence
   - fan-in (how many files import the module containing the usage)
   - whether the file is an entrypoint (a page, layout, route handler or middleware)
   - whether there is a test file covering the module (by import graph)
   - sync-to-async signature changes
   - behaviour-only changes with no syntax change (caching defaults)

   It outputs `risk_signals[]` and a computed `suggested_severity` with an explanation per signal. Usages that match no rule are flagged as `unmapped`, which is an input for the M5 lenses and gate 2.
8. **Sizing and scope (`src/analysis/sizing.ts`, `src/core/{proposeScope,setScope}.ts`, tools, CLI `scope`; deterministic, no LLM).**
   - **`propose_scope`** (input `run_id`) returns a size, a summary and the questions.
   - **Size** is computed from the facts, never guessed:
     - `none` only when all of these hold: zero usages match a rule, the scan is complete (no `unparsed_files`, `unresolved_dynamic` or `skipped_by_limit`), and no dependency has a `peer_conflict`. The output still lists the pack's `behavior_change` rules in one line each ("not found in your code; listed because behaviour changes can hide").
     - `small` when the scan is complete, the matched usages are at most `--small-max-usages` (default 10, recorded per run and tuned from M7 data), every one is covered by a pack codemod, and none has a `suggested_severity` of `high` or `blocker`.
     - `full` otherwise.
   - **Questions** come from the facts, and only when relevant. Each has an ID, fixed options and a default:
     - `targets`: when more than one app or package uses the library. Options are the package roots found by `scan_repo`; the default is all.
     - `stop_at`: when the range spans more than one major and the pack lists the intermediates. The default is the target.
     - `include_deprecated`: when any matched usage has a `necessity: deprecated` rule. The default is yes.
     - `depth`: when the size is `none` or `small`, offering to plan in full anyway. The default is the computed size. It can only move toward `full`, never down.
     - An information line, not a question: the level, and whether any checks are declared.
   - **`set_scope`** (input `run_id` and `answers{question_id: option_id}`) records the answers as a `scope.set` event.
     - An answer that is not one of the offered options is rejected. There are no free-text answers.
     - Scope can only narrow. It cannot touch paths, the deny list, the level, the checks or `--out`. `stop_at` can only pick an intermediate the pack lists, between `from` and `to`, and it becomes the effective target, which M4's doc version pin uses.
     - Scope is frozen once the first lens packet is fetched (M5), so it can't be used mid-run to drop items that fail a gate.
     - Unanswered questions take their defaults, and the report says which answers were defaults.
     - Excluded usages get engine-written `out_of_scope` entries with the reason `scope: <question>=<answer>`.
   - The CLI `scope` prints the proposal, and `scope --answers <file.json>` sets it, for CI.

## Files and modules

`src/schema/rulePack.ts`, `src/rules/loader.ts`, `src/verify/codemodIds.ts`, `src/core/{getRulePack,assessRisk}.ts`, `src/tools/{getRulePack,assessRisk}.ts`, `src/cli/{pack,risk}.ts`, `src/analysis/{risk,sizing}.ts`, `src/core/{proposeScope,setScope}.ts`, `src/tools/{proposeScope,setScope}.ts`, `src/cli/scope.ts`, `src/schema/scope.ts`, `test/fixtures/next-clean/` (a Next.js app with no affected code), `rules/nextjs-upgrade/{rules.json,CHANGELOG.md,SKILL.md,references/*,references-src/*}`, `scripts/{build-pack,lint-packs}.ts`, `eval/seeded/next-tricky/**` (`rule_id` tags and cases for uncovered rules), `test/unit/{rulePack,risk,lintPacks,sizing,scope}.test.ts`, `test/permissions/scope-cannot-widen.test.ts`.

## Tests

- **Schema:** rejects unknown keys, a missing trigger, an executable-looking field and a codemod entry with a `command` key.
- **Lint:** one failing fixture per lint rule (an overly broad trigger, 150 lines, a missing reference, an unknown codemod ID, a `.sh` file in the pack, an unbumped version, a rule with no seeded case, a code-usage kind with no indirect seeded entry, a rule with no `lands_on`).
- **Generator:** golden-file test, so the same input gives byte-identical output.
- **Risk:** a table-driven test of the signals on the `next-tricky` seeded repo. Async request APIs used through a helper, caching-only changes and peer conflicts must come out at `high` or `blocker` suggested severity.
- **Loader:** `--rules-dir` outside the bundled dir is refused, and the pack version appears in the run record.
- **Sizing:** `next-clean` comes out `none`, and `next-tricky` comes out `full`. Each `none` condition is shown to matter: an unparsed file, an unresolved dynamic import, a peer conflict or a single matched usage each turns `none` into `small` or `full`. A usage with no codemod, or a high-risk one, turns `small` into `full`.
- **Scope:** an answer outside the offered options is rejected; `depth` can move up but not down; `set_scope` after the first lens packet is refused; excluded usages get engine-written `out_of_scope` reasons; unanswered questions take their defaults and are reported as defaults.
- **Permissions (`scope-cannot-widen`):** no `set_scope` input can change the paths, the deny list, the level, the checks or `--out`, and a `stop_at` outside the pack's range is rejected.
- **Permissions:** the full suite still passes.

## Acceptance criteria

- `npm run build:packs` regenerates SKILL.md and references with zero diff, and editing `rules.json` without regenerating fails CI.
- SKILL.md is at most 100 lines and has a narrow trigger. The lint passes.
- `assess_risk` on the seeded repo flags every planted hard case at `medium` or above, with signal explanations.
- Every codemod reference resolves to a registry ID, and the plan can list which rules each codemod covers.
- `propose_scope` gives `none` on `next-clean` and `full` on `next-tricky`, each with the reasons, and `set_scope` cannot widen anything (the permissions test passes).
- Every rule has a seeded case, a `lands_on` value and a `necessity` value, and the changelog records which releases in the range the rules were checked against.
- The pack name, version and hash are printed at startup and recorded per run.

## Risks

- **The pack is wrong or out of date, which is a supply-chain risk to plan quality.** Mitigation: version and changelog, PR review, rule re-verification against Context7 in M4, and from M7 a golden-set rerun on every pack change.
- **Next.js ships a new major during the build.** Mitigation: the pack's ranges are explicit; a new major is a new pack version with its own changelog entry and eval rerun, not a silent edit.
- **Over-trusting codemods.** Mitigation: a codemod-covered usage still needs a finding with a verify step; gate 2 coverage does not count the codemod as coverage on its own.
- **A skill trigger that is too broad loads on unrelated tasks.** Mitigation: the lint blocklist plus a manual check in Cursor and Claude Code that the skill does not trigger on a generic React question.
- **Over-tuned risk heuristics.** Mitigation: keep the signals explainable, and tune the weights only from M7 eval data.

## Dependencies

- M2: usage kinds, the usage index and the import graph (for fan-in and test coverage).

## Must not break

The `find_usages` output and recall ratchet, the permissions suite and the repo hash.
