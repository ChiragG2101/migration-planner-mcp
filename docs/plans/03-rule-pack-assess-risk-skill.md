# M3 - Knowledge and pack schema, Next.js pack, get_rule_pack, assess_risk, sizing and scope, generated skill

**PRD refs:** sections 2 (retrieval rows, sizing and scope), 9 (skills, knowledge and packs, trust model), 8 (Rule packs and skills row), 11. **Done when:** the Next.js pack and its SKILL.md are generated from the knowledge and pack files, any `from` to `to` inside the supported range composes the right rules, and the skill and pack lint passes.

## Scope

- In scope:
  - the two-layer data model (`docs/design.md` D10): **knowledge** per library, kept by release, and thin **packs** that compose libraries
  - both version schemes v0.1 needs (`semver` for npm and `pep440` for PyPI) and range composition, so the Django pack in M10 needs no core change
  - the typed match kinds both v0.1 packs need, for the same reason
  - the Next.js knowledge (`next`, `react`) and the `nextjs-upgrade` pack
  - a loader, `get_rule_pack`, a deterministic `assess_risk`, and sizing and scope (`propose_scope`, `set_scope`; D8)
  - a generator that builds `SKILL.md` and `references/` from the pack and its knowledge
  - the skill and pack lint in CI
  - the maintainer tools for knowledge (D11): the release drafter and the pack update report
- Out of scope: Context7 (M4), producing findings (M5), running codemods (M8; this milestone only references them), the Django knowledge and pack (M10), third-party packs (not supported in v0.1), and pre-release versions (refused).

## Tasks

1. **Knowledge schema (`src/schema/knowledge.ts`, Zod).** Facts about one library, independent of any pack. One folder per library: `knowledge/<ecosystem>/<library>/`.
   - **`library.json`:**
     - `id` (for example `npm/next`), `ecosystem` (`npm` or `pypi`), `packages[]` (the package names it covers; React's knowledge covers `react` and `react-dom`), `language`
     - `version_scheme` (`semver` or `pep440`) and `release_unit` (`major` for Next.js, `minor` for Django's X.Y feature releases)
     - `lts[]` (optional; Django's LTS releases, used by the `stop_at` question)
     - `covered_from`: the oldest release whose knowledge is complete
     - `doc_sources[]`: official doc locations as `https://` URL prefixes ending in `/` (M4 labels docs with it, D9)
     - `release_notes`: where the official notes for a release live (a URL template with `{version}`), their format (`md`, `mdx` or `rst`), and the section headings that list breaking changes, removals and deprecations. The drafter and the report read it.
     - `codemods[] {id, notes}`: the official codemods for this library, by registry ID only
   - **`releases/<release>.json`**, one file per release unit (for example `15.json`, `4.2.json`). A large release may be a folder of area files (`releases/4.0/settings.json`, `orm.json`, …), which the loader merges. Each file holds:
     - `rules[]`: changes first made in this release
     - `events[]`: later events for rules defined in earlier files, as `{rule, event, version?}` (for example "`next/sync-request-apis` removed in 16"). **Release files only gain entries for their own release**; an old file changes only to correct a mistake, recorded in the library's `CHANGELOG.md`.
   - **Each rule:**
     - `id`, prefixed with the library (`next/async-request-apis`), unique across all knowledge, and a short `title`
     - `event`: the first event (`deprecated`, `removed`, `changed_behavior`, `changed_default`, `renamed` or `peer_requirement`), with an optional finer `version` inside the release (a patch-level change)
     - `replacement_since?`: the release in which the new form first existed
     - `match`: what to look for, typed (task 3)
     - `concern`, `default_severity`, `mapping` (from and to text), `no_equivalent` (bool), `codemod?` (an ID from the library's `codemods[]`), `notes`, `verify_hint`, `rollback_hint`
     - `requires {library, range}`: required on a `peer_requirement` rule and rejected on any other. It names the companion library and the version range the primary needs from this release (for example `npm/react`, `>=19`). The rule's `match` says where the requirement applies, so a requirement that only the app router has uses a match on app-router files (`docs/design.md` D13).
     - `source`: **one** official URL (under a `doc_sources` prefix) for the section that documents the change. It is the only doc reference stored. `doc_topics[]` are search terms the agent looks up in Context7 at run time (M4); they are not links.
     - `status`: `draft` or `reviewed`. **Only `reviewed` rules load.** Drafts may be committed so work can span PRs; the loader skips them and reports the count.
   - **No executable fields.** The schema rejects unknown keys. The lint rejects strings that look like shell commands in any field except the display-text fields: `verify_hint` and `rollback_hint` in rules, and `checks_hint` in packs. These are shown to people and never executed (C3, C9).
2. **Pack schema (`src/schema/pack.ts`, Zod).** `packs/<pack>/pack.json` is thin. It says which knowledge to use and how to plan with it, and holds no rules:
   - `name`, `version` (semver of the pack's content), `kind` (`upgrade` or `swap`), `language`, `trigger` (one sentence)
   - `libraries[] {id, role}`: one `primary` (the library being upgraded), plus `companion` libraries whose required range follows from the primary's `peer_requirement` rules (the Next.js pack: `npm/next` primary, `npm/react` companion)
   - `supported {from, to}`: the primary's release range this pack has been checked for. It must sit inside the knowledge's `covered_from` and its newest reviewed release.
   - `usage_adapter` (a registry ID, M2), `usage_kinds[] {kind, lens}` (which M5 lens gets each usage kind), `staging` (`leaf_first` or `config_first`), `checks_hint` (display text, never executed), `references[]`, `seeded` (the pack's seeded repo under `eval/seeded/`, for example `next-tricky`; the lint reads its `ground_truth.json`)
   - `CHANGELOG.md` next to it. The pack version must bump when `pack.json` or any knowledge file it uses changes. The run records `pack@version#hash`, where the hash covers the pack and every knowledge file it used.
3. **Typed match kinds (`src/schema/match.ts`).** A rule's `match` is one of a fixed set, each with typed fields:
   - `import {module, name?}` (TS/JS and Python imports)
   - `call {module, name}`
   - `attribute {module, path}` (Python dotted access)
   - `config_key {file_kind, path}` (`next.config`, `tsconfig`)
   - `setting {name}` (Django settings, including settings that rely on a changed default)
   - `string_ref {dotted_path}` (dotted paths in settings)
   - `template_tag {name}` and `template_filter {name}`
   - `dependency {package, range}`
   - `file_convention {glob}` (behaviour changes anchored to file types, such as route handlers)

   The set covers both v0.1 packs, so M10 adds no core change. Each usage adapter declares the match kinds it supports (M2). A new kind for a future pack is a core change, reviewed as code.
4. **Version schemes and range composition (`src/rules/versions.ts`, `src/rules/compose.ts`).** Core code, since packs are data and can't run code.
   - `semver` and `pep440` parse and compare versions. Pre-releases (`canary`, `rc`, `a`, `b`, `dev`) are refused with "pre-release versions not supported in v0.1", both here and at ingest: M3 adds the check to `src/pipeline/ingest.ts`, using the library's version scheme, so a pre-release never gets a run.
   - **The pack's `supported` range bounds the run, also checked at ingest.** Both bounds are compared by release unit (the library's `release_unit`), so `5.2.7` counts as `5.2` and `15.3.2` as `15`. A target T whose release unit is newer than `supported.to` is refused with "target <T> is newer than this pack has been checked for (up to <to>)". An installed S whose release unit is older than `supported.from`, but not older than `covered_from`, composes normally and reports "your version is older than this pack's checked range", and the size can't be `none`.
   - **Composition** for a run with installed version S and target T (both resolved at ingest, M1). A rule applies when it has at least one event with a version in (S, T]. Then, per rule:
     - `necessity` is `breaks` if a `removed`, `renamed`, `changed_behavior`, `changed_default` or `peer_requirement` event falls in (S, T]; otherwise it is `deprecated`. Sizing, the scope questions and routing read it (D8).
     - `lands_on` is `source` if `replacement_since` is at most S (the new form already exists in the installed version); otherwise it is `target`, which includes rules with no `replacement_since`. M6 staging reads it (D5).
   - Companion libraries are composed from their installed version to the lowest version that satisfies every `requires` range of the primary's `peer_requirement` rules in range. Conditional requirements are applied too, because flagging is the safe direction (PRD section 3). When a requirement's `match` finds nothing in the run, the plan says the companion upgrade may not be needed.
   - If S is older than `covered_from`, composition still runs and reports "changes before `<covered_from>` were not checked", and the size can't be `none`.
   - `stop_at` (D8) replaces T and must be a release unit inside `supported`.
5. **Next.js knowledge and pack.**
   - `knowledge/npm/next/` and `knowledge/npm/react/` (React's covers `react-dom`), with `library.json` and release files for every release unit in the pack's supported range. `packs/nextjs-upgrade/pack.json` (with `seeded: next-tricky`), `CHANGELOG.md`, `references-src/*.md`.
   - The supported range is fixed at the start of M3 against the current Next.js release and upgrade guides, and recorded in the pack changelog with the date. It should start at least one major before the newest one, so repos that skipped a cleanup are covered.
   - Rules cover each usage kind from M2: async request APIs, caching and segment config, config keys, removed or renamed packages, the React changes the Next.js majors require (as `peer_requirement` plus React's own rules), peer-dependency conflicts, and type changes.
   - Codemod references are the official `@next/codemod` transforms (including the upgrade command) and React's official codemods, each by registry ID. Which rules a codemod covers is derived from the rules that name it, so the plan can show what the codemod leaves for manual work.
   - **Every rule is drafted from the official release notes with the drafter (task 10), then completed and reviewed.** Nothing is written from memory.
   - Every reviewed rule reachable in the supported range has at least one seeded case. M3 adds `rule_id` to the `next-tricky` ground-truth entries and plants a case for any rule that has none.
6. **Generator (`scripts/build-pack.ts`, `npm run build:packs`).** Reads `pack.json`, `references-src/` and the reviewed knowledge in the supported range, and writes:
   - `packs/nextjs-upgrade/SKILL.md`, at most about 100 lines. Frontmatter `name` and `description`, where description = the trigger sentence: "Use when planning a Next.js major version upgrade in a TypeScript or JavaScript repo." The body is the steps, the tool order (`scan_repo` → `find_usages` → `get_rule_pack` → `assess_risk` → `propose_scope` → ask the user → `set_scope` → `plan_migration` (each lens registers its docs with `get_migration_docs`, M5) → `merge_findings` → `validate_plan` → `emit_plan`, then at L1 `verify_stage`), the output contract (the finding schema by name, not inline) and pointers to the references. No API tables inline.
   - `packs/nextjs-upgrade/references/`: one file per release in the range, plus `react-changes.md` and `codemods.md`, each with a header naming the pack version.
   - Generated files carry a "do not edit; generated from pack vX.Y.Z" banner. CI regenerates them and fails on a diff, which is the drift check.
7. **Skill and pack lint (`scripts/lint-packs.ts`, run in `npm run lint` and CI).** It fails on:
   - a missing or overly broad trigger. The description must name the library and the migration and contain "Use when", and a blocklist rejects phrases like "working with React" and "any".
   - SKILL.md over the line limit, or a reference link to a file that does not exist
   - a codemod reference whose ID is not in the core registry list (`src/verify/codemodIds.ts`; M8 implements the registry), or a rule naming a codemod its library doesn't list
   - a string that looks like a shell command outside the display-text fields (task 1)
   - a pack version not bumped while `pack.json` or a knowledge file it uses changed (compared with the PR's merge base in CI), or a missing CHANGELOG entry for the current pack or library version
   - a rule `id` used twice, an `events[]` entry naming an unknown rule, or a release file holding an event for a different release
   - a `source` that is not under the library's `doc_sources`, an empty `doc_sources`, or a prefix that is not `https://`
   - a reviewed rule reachable in a pack's supported range whose match kind the pack's usage adapter does not declare
   - a reviewed rule reachable in a pack's supported range with no `expect: change` seeded case in the `ground_truth.json` of the pack's `seeded` repo, or a `seeded` repo that doesn't exist
   - a code-usage kind (calls and imports, not config keys or dependency ranges) with no indirect seeded entry (through a helper, wrapper or re-export)
   - `supported` outside the knowledge's `covered_from` and newest reviewed release
   - any file under `knowledge/` or `packs/` other than `.json` or `.md` (no scripts)
8. **Loader (`src/rules/loader.ts`).** Loads knowledge and packs only from the repo's bundled `knowledge/` and `packs/` dirs in v0.1, and validates them with Zod. A `--rules-dir` pointing anywhere else is refused with "third-party packs not supported in v0.1". It skips `draft` rules and logs their count, and at startup it logs the pack name, version and content hash to stderr. Every run records `pack@version#hash` in `runs.versions_json`.
9. **`get_rule_pack` (core, tool and CLI `pack`).** Input is `run_id`, or `source` and `target`. It returns the pack version, the **composed** rules for the run's range with their derived `necessity` and `lands_on` (optionally filtered to usage kinds present in the run), the codemod references with the rules they cover, any "not checked before `<covered_from>`" note, and the reference file paths as MCP resources, so the agent loads them only on demand.
10. **Maintainer tools for knowledge (D11).** These are under `scripts/`, outside the engine. They may use the network because they are maintainer tooling, never run in default CI, and are never imported by `src/` (an import lint enforces this).
    - **Release drafter (`scripts/draft-release.ts`, `npm run knowledge:draft -- <library> <release>`).** Fetches the official release notes for one release from `library.json`'s `release_notes`. It splits the listed sections into items with a plain parser (headings and bullets in `md`, `mdx` or `rst`; no model, C7). For each item it writes a `draft` rule with `title`, `source` (the item's anchor URL), and an `event` guessed from the section (removed, deprecated or changed), leaving the rest empty. It never overwrites a reviewed rule. A contributor's own agent then completes the drafts with the `add-release-knowledge` contributor skill, and a human reviews and flips them to `reviewed`.
    - **Pack update report (`scripts/pack-docs-report.ts`, `npm run pack:report -- <pack>`).** For every release in the pack's supported range, it fetches the same official sections and prints:
      - **missing:** official items with no rule whose `source` points at them
      - **stale:** rules whose `source` no longer resolves, or whose section anchor is gone
      - **drafts:** rules still in `draft`
      - **unseeded:** reviewed rules with no seeded case

      It reads the official sources directly, not Context7. Its output is attached to the pack PR (the `add-pack` skill says so) and is **not committed**. It replaces the earlier Context7-based cross-check.
11. **`assess_risk` (`src/analysis/risk.ts`, core, tool and CLI `risk`; deterministic, no LLM).** For each usage in the run it computes signals:
    - whether a composed rule matched, its default severity and its derived `necessity`
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
12. **Sizing and scope (`src/analysis/sizing.ts`, `src/core/{proposeScope,setScope}.ts`, tools, CLI `scope`; deterministic, no LLM).**
    - **`propose_scope`** (input `run_id`) returns a size, a summary and the questions.
    - **Size** is computed from the facts, never guessed:
      - `none` only when all of these hold: zero usages match a composed rule, the scan is complete (no `unparsed_files`, `unresolved_dynamic` or `skipped_by_limit`), no dependency has a `peer_conflict`, and the installed version is not older than `covered_from` or `supported.from`. The output still lists the composed `changed_behavior` and `changed_default` rules in one line each ("not found in your code; listed because behaviour changes can hide"). Usages that `find_usages` found but that match no composed rule (for example code already in the target form) are marked out of scope by the engine when it builds the `none` plan (M6), so gate 2 holds without any lens.
      - `small` when the scan is complete, the matched usages are at most `--small-max-usages` (default 10, recorded per run and tuned from M7 data), every one is covered by a codemod, and none has a `suggested_severity` of `high` or `blocker`.
      - `full` otherwise.
    - **Questions** come from the facts, and only when relevant. Each has an ID, fixed options and a default:
      - `targets`: when more than one app or package uses the library. Options are the package roots found by `scan_repo`; the default is all.
      - `stop_at`: when the range spans more than one release unit. Options are the release units in range (and, for libraries with `lts[]`, the LTS releases are marked). The default is the target.
      - `include_deprecated`: when any matched usage has a derived `necessity: deprecated`. The default is yes.
      - `depth`: when the size is `none` or `small`, offering to plan in full anyway. The default is the computed size. It can only move toward `full`, never down.
      - An information line, not a question: the level, and whether any checks are declared.
    - **`set_scope`** (input `run_id` and `answers{question_id: option_id}`) records the answers as a `scope.set` event.
      - An answer that is not one of the offered options is rejected. There are no free-text answers.
      - Scope can only narrow. It cannot touch paths, the deny list, the level, the checks or `--out`. `stop_at` becomes the effective target, so composition (task 4) and M4's doc version pin both use it.
      - Scope is frozen at whichever comes first: fetching the first lens packet (M5) or calling `merge_findings` (M6). A `none` run fetches no packet, so `merge_findings` is what freezes it. Either way, scope can't be used mid-run to drop items that fail a gate (`docs/design.md` D12).
      - Unanswered questions take their defaults, and the report says which answers were defaults.
      - Excluded usages get engine-written `out_of_scope` entries with the reason `scope: <question>=<answer>`.
    - The CLI `scope` prints the proposal, and `scope --answers <file.json>` sets it, for CI.

## Files and modules

`src/schema/{knowledge,pack,match,scope}.ts`, `src/rules/{loader,versions,compose}.ts`, `src/pipeline/ingest.ts` (the pre-release and `supported` checks), `src/verify/codemodIds.ts`, `src/core/{getRulePack,assessRisk,proposeScope,setScope}.ts`, `src/tools/{getRulePack,assessRisk,proposeScope,setScope}.ts`, `src/cli/{pack,risk,scope}.ts`, `src/analysis/{risk,sizing}.ts`, `knowledge/npm/{next,react}/{library.json,CHANGELOG.md,releases/*}`, `packs/nextjs-upgrade/{pack.json,CHANGELOG.md,SKILL.md,references/*,references-src/*}`, `scripts/{build-pack,lint-packs,draft-release,pack-docs-report}.ts`, `scripts/lib/release-notes.ts` (the shared notes parser), `.agents/skills/add-release-knowledge/SKILL.md` (exists; keep it in step with the schema), `eval/seeded/next-tricky/**` (`rule_id` tags and cases for uncovered rules), `test/fixtures/next-clean/` (a Next.js app with no affected code), `test/fixtures/knowledge/` (small fake libraries for both schemes), `test/fixtures/release-notes/` (recorded notes in `md`, `mdx` and `rst`), `test/unit/{knowledge,pack,versions,compose,ingest,lintPacks,risk,sizing,scope,releaseNotes}.test.ts`, `test/permissions/scope-cannot-widen.test.ts`.

## Tests

- **Schemas:** unknown keys, a missing trigger, an executable-looking field, a codemod entry with a `command` key, a reviewed rule with an empty `match`, a `peer_requirement` rule without `requires`, and `requires` on any other kind of rule are all rejected. A draft with an empty `match` is accepted but not loaded.
- **Version schemes:** ordering tables for `semver` and `pep440`, including `4.2` vs `4.10`, patch levels, and refused pre-releases in each scheme. In `ingest.test.ts`, ingest refuses a pre-release source or target (for example `next@16.0.0-canary.1`, `django==5.2a1`) with the same message. With `supported.to` at `15` and `5.2`, it refuses `next@16.0.0` and `django==6.0` and accepts the patch releases `next@15.3.2` and `django==5.2.7`.
- **Composition (`compose.test.ts`), on fake libraries in both schemes.** This is the core of the milestone and is table-driven:
  - an event exactly at S is excluded, and one exactly at T is included
  - a rule deprecated in range and removed after T is `deprecated`
  - one deprecated before S and removed in range is `breaks`
  - one deprecated before S and not removed by T is not included
  - `replacement_since` at S gives `source`, after S gives `target`, and absent gives `target`
  - a companion range follows the `requires` ranges of the primary's `peer_requirement` rules, and the stricter one wins when two disagree
  - a conditional requirement whose match finds nothing is still applied, with the "may not be needed" note
  - S older than `covered_from` gives the "not checked" note, and S older than `supported.from` gives the "older than this pack's checked range" note
  - `stop_at` narrows T
  - a draft rule never appears
- **Lint:** one failing fixture per lint rule.
- **Generator:** golden-file test, so the same input gives byte-identical output.
- **Release-notes parser:** on the recorded `md`, `mdx` and `rst` fixtures, it extracts the expected items with anchors, and an unknown section heading is reported, not guessed.
- **Drafter and report (offline, on recorded fixtures):** the drafter never overwrites a reviewed rule; the report lists a planted missing item, a planted dead source and a planted draft.
- **Risk:** a table-driven test of the signals on the `next-tricky` seeded repo. Async request APIs used through a helper, caching-only changes and peer conflicts must come out at `high` or `blocker` suggested severity.
- **Loader:** `--rules-dir` outside the bundled dirs is refused, drafts are skipped and counted, and the pack version and hash appear in the run record.
- **Sizing:** `next-clean` comes out `none`, and `next-tricky` comes out `full`. Each `none` condition is shown to matter: an unparsed file, an unresolved dynamic import, a peer conflict, a single matched usage, or an installed version older than `covered_from` or `supported.from` each turns `none` into `small` or `full`. A usage with no codemod, or a high-risk one, turns `small` into `full`.
- **Scope:** an answer outside the offered options is rejected; `depth` can move up but not down; `set_scope` after the first lens packet is refused, and so is `set_scope` after `merge_findings` on a `none` run; excluded usages get engine-written `out_of_scope` reasons; unanswered questions take their defaults and are reported as defaults.
- **Permissions (`scope-cannot-widen`):** no `set_scope` input can change the paths, the deny list, the level, the checks or `--out`, and a `stop_at` outside the pack's supported range is rejected.
- **Permissions:** the full suite still passes, and an import lint shows nothing under `src/` imports from `scripts/` or `eval/`.

## Acceptance criteria

- `npm run build:packs` regenerates SKILL.md and references with zero diff, and editing a knowledge or pack file without regenerating fails CI.
- SKILL.md is at most 100 lines and has a narrow trigger. The lint passes.
- For every pair of release units inside the Next.js pack's supported range, `get_rule_pack` returns the composed rules with derived `necessity` and `lands_on`, and the composition tests pass for both version schemes.
- `assess_risk` on the seeded repo flags every planted hard case at `medium` or above, with signal explanations.
- Every codemod reference resolves to a registry ID, and the plan can list which rules each codemod covers.
- `propose_scope` gives `none` on `next-clean` and `full` on `next-tricky`, each with the reasons, and `set_scope` cannot widen anything (the permissions test passes).
- Every reviewed rule reachable in the supported range has a seeded case. `npm run pack:report -- nextjs-upgrade` was run against the live official notes and its output attached to the M3 PR, with every "missing" item either added as a rule or explained.
- The pack name, version and hash are printed at startup and recorded per run.

## Risks

- **Knowledge is wrong or out of date, which is a supply-chain risk to plan quality.** Mitigation: rules are drafted from the official notes and reviewed by a human, the update report runs on every pack change, library and pack changelogs, and from M7 a golden-set rerun on every pack change.
- **Range maths off by one (inclusive vs exclusive bounds), or a version scheme quirk.** Mitigation: the table-driven composition and ordering tests above, on both schemes.
- **The official notes change format and the parser breaks.** Mitigation: the parser reports unknown sections instead of guessing, and its fixtures are recorded. The drafter is a starting point; the human review is the check.
- **A new major ships during the build.** Mitigation: it's one new release file plus a pack version bump and changelog entry, and the eval reruns. Old release files are not rewritten.
- **Over-trusting codemods.** Mitigation: a codemod-covered usage still needs a finding with a verify step; gate 2 coverage does not count the codemod as coverage on its own.
- **A skill trigger that is too broad loads on unrelated tasks.** Mitigation: the lint blocklist plus a manual check in Cursor and Claude Code that the skill does not trigger on a generic React question.
- **Over-tuned risk heuristics.** Mitigation: keep the signals explainable, and tune the weights only from M7 eval data.

## Dependencies

- M1: ingest resolves the installed and target versions that composition uses.
- M2: usage kinds, the match kinds each usage adapter declares, the usage index and the import graph (for fan-in and test coverage).

## Must not break

The `find_usages` output and recall ratchet, the permissions suite and the repo hash.
