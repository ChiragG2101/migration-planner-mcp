# M12 - Django pack and the v0.2 release

**PRD refs:** sections 4 (scope, pack 2), 9 (packs and skills), 10 (eval). **Done when:** the Django pack is added with **no core changes** and beats the baseline on recall, and the README claims two packs only once that holds; v0.2.0 is published to npm and tagged.

**Moved from M10 on 2026-11-01 (`docs/design.md` D60).** v0.1 ships with the Next.js pack only. This milestone is the headline of v0.2 and starts after M11. The text below is M10's Django scope, tasks, tests and acceptance, moved unchanged except where a line named M10 or both packs.

## Scope

- In scope:
  - the Django LTS to LTS upgrade pack, its usage adapter, generated skill and references
  - Django eval cases (golden and seeded)
  - the Django skill in the generated plugin bundle, and the README's eval table and limits for two packs
  - the v0.2 release: npm publish and the `v0.2.0` tag, as M11 does for v0.1 (`docs/design.md` D61)
- Out of scope: third-party packs loaded from outside the repo, and other languages.
- Cut order: if behind, the Django pack keeps its golden cases and the "no core changes" check, but ships fewer rules.

## Why Django is pack 2

It is a different language, package manager, test runner and project layout from pack 1. If the engine built for Next.js handles it with only pack data and one usage adapter, the engine is general. If it can't, this milestone finds out where it isn't, which is the point.

## "No core changes" definition

Adding the pack may only touch:

- `knowledge/pypi/django/**` and `packs/django-upgrade/**`
- one new usage adapter `src/analysis/usages/django.ts`, registered with one added line and no removed line in `src/analysis/usages/registry.ts` (`removed === 0` and `added <= 1`; a one-line swap of an existing export fails). A re-export file `index.ts` collects with `Object.values`. A module namespace's keys are sorted alphabetically, not in export order; lookup is by adapter id. The registry file and this mechanism were added in Core PR A so registration is genuinely one added line (`docs/design.md` D57). `src/analysis/usages/index.ts` no longer changes when a pack is added.
- eval data (`docs/design.md` D15): the Django cases under `eval/cases/` (a case's pack is the `pack` field of its `case.json`), both new ones and the M0 ones (`django-ror-api-548`, `django-thunderstore-1369`, committed with only `case.json`), which the PR may complete because they have no recorded runs on the base branch. Completing a case may add files (`truth.json` and the like) and may change only `notes` and `checks` in its `case.json`; the pinned fields (`id`, `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`, `source`, `target`, `tags`, `license`) stay byte-identical. The PR may never remove a pending case, its own pack's or another's; that goes through D15's exception (b) in a core PR. Also a new line for each new case in the coverage matrix in `eval/cases/README.md` (existing lines may not be edited or deleted); the Django cases' recorded engine and baseline runs under `eval/runs/<django ids>/` (new files only); the seeded repo `eval/seeded/django-tricky/`; and the regenerated `eval/results.md`. No case, run or completion for another pack is allowed. Existing cases (with recorded runs on the base branch) and their runs are add-only on every PR, which M7's `scripts/check-eval-add-only.ts` checks.
- the adapter's unit tests and fixtures under `test/`, as added files only (a modified or deleted test file fails)
- docs (`docs/`, `README.md`)
- the outputs the pack's build and eval regenerate: `plugin/**`, `eval/history/`, `eval/seeded/recall.md` and the new pack's entry in `eval/seeded/ratchet.json`. The drift check guards the generated content. An entry that existed on the base branch may not change. A new floor must equal the measured recall, which `npm run recall -- --check --base` enforces (INV-50); `check-core-untouched` does not measure it, because importing `eval/seeded/recall.ts` would load the PR's own adapter. Under `eval/history/`, files may only be added. In `eval/cases/coverage-gaps.json` (a JSON array of strings), every base entry that does not start with `<own-pack>:` must still be present at HEAD; the PR's own pack's entries may be added or removed, and a version that is not a string array fails closed. A removed-line count cannot express that rule: appending to the array edits the previous line's comma, and the Django PR removes its own pending entry.

The Python language adapter (M2), the text scanner (M2), the staging options (M6) and the `django-upgrade` codemod registry entry (M8) already exist, so none of them count as changes here.

A CI check (`scripts/check-core-untouched.ts`, over the pure `scripts/lib/coreUntouched.ts`, `docs/design.md` D57) is an allowlist. It runs on every pack PR (a PR that changes anything under `packs/` or `knowledge/`, `docs/design.md` D15) and fails it on any changed file outside the list above, on a pack PR that owns more than one pack, on a `src/analysis/usages/registry.ts` change that is not a pure addition of at most one line (`removed === 0` and `added <= 1`), on more than one new adapter file or an edit to an existing adapter, and on a `knowledge/` change outside the libraries the owned pack's `pack.json` names. It also enforces the pack-PR eval rules above: cases, completions and runs only for the PR's own pack (a case whose `case.json` can't be read fails closed), only `notes` and `checks` changed in a completed case's `case.json`, only added lines in `eval/cases/README.md`, the coverage-gaps rule above, and added files only under `test/`. It imports neither `src/` nor `eval/seeded/recall.ts`. M7's `scripts/check-eval-add-only.ts` runs alongside it, as on every PR. So everything else is protected, notably all of `src/` apart from the new adapter (including `src/analysis/` risk, sizing, scanner and snippet code, `src/rules/`, `src/schema/` with the match kinds, `src/docs/`, `src/cli/`, `src/tools/` and `src/server.ts`), `prompts/`, `scripts/` (so a pack PR can't loosen the pack lint or the generator it is checked by), and the eval scoring code (`eval/runner.ts`, `eval/metrics.ts`, `eval/baseline/`, `eval/seeded/recall.ts`). If the pack cannot be added without a core change, that is a design bug. Fix it in a separate, reviewed core PR **before** the pack PR, and record the fix in `docs/design.md`.

The check was built in M10's Core PR A and runs in CI on every PR (D57). This milestone's pack PR is the first real pack PR it judges.

## Delivery order

1. **Core fixes first.** Any core change the pack turns out to need is its own reviewed core PR before the pack PR (see "No core changes").
2. **Pack PR:** the Django adapter, knowledge, pack, eval cases and seeded repo (tasks 1 to 3), with the regenerated `plugin/` and the README update (task 4), all inside the allowlist. `check-core-untouched` and `check-eval-add-only` must pass on it unchanged.
3. **Release PR, then publish (task 5).** The version bump changes `package.json`, which is outside the pack PR's allowlist, so it is its own PR after the pack PR merges and the other acceptance criteria below hold (D61).

**Live-run handover (D39, D41).** The Django golden runs (N of at least 3 engine runs and N baseline runs per case, one host agent) and the L1 run on a Django case need a live host session on the maintainer's own key. The builder prepares the cases, `truth.json`, `django-tricky` and the run instructions, then stops and hands over, as M7 did. The beat check and the `eval/results.md` acceptance line cannot pass before that. Decision to record: which host and model make the Django runs. Use the M7 host (Cursor/databricks-claude-sonnet-4-6) unless the maintainer says otherwise, so the two packs stay comparable.

## Tasks

1. **Django usage adapter (`src/analysis/usages/django.ts`).** It uses the M2 `UsageAdapter` interface, the Python adapter and the text scanner. The starting list below is a draft. **Every item is checked against the official Django release notes and deprecation timeline for each feature release in the range (drafted with M3's release drafter) before rules are written.**
   - Settings: removed or renamed settings and changed defaults, read from the settings modules found by `scan_repo`, including settings split across files.
   - Dotted-path strings in settings (middleware, apps, backends, storages, authentication backends), followed through the `string_ref` edges from M2.
   - Imports of removed or moved modules and functions.
   - Model and `Meta` options that were removed or changed, and custom field subclasses.
   - URLconfs, including old-style patterns in long-lived projects.
   - Templates: removed or changed tags and filters, found with the text scanner and labelled `heuristic`.
   - Middleware, signals and management commands that override changed base-class methods.
   - Third-party Django apps whose declared support range excludes the target version, read from the lockfile and labelled `peer_conflict`.
2. **Knowledge (`knowledge/pypi/django/`) and pack (`packs/django-upgrade/`).** Built entirely on M3's data model, version schemes and match kinds, with no core change.
   - `library.json`: `version_scheme: pep440`, `release_unit: minor` (Django's X.Y feature releases), `lts[]` (the LTS releases), `covered_from`, `doc_sources` (`https://docs.djangoproject.com/` and the docs folder of the official `django/django` repo), `release_notes` (the per-release notes in the official repo, format `rst`, with the backwards-incompatible, removed and deprecated sections), and the `django-upgrade` codemod by registry ID.
   - Release files for every feature release in the supported range, drafted from the official notes with `npm run knowledge:draft`, then completed and reviewed (`add-release-knowledge` skill). Django's deprecation timeline maps directly onto `deprecated` and `removed` events, so `necessity` and `lands_on` are derived, not typed in.
   - `pack.json`: `kind: upgrade`, primary library `pypi/django`, `supported` spanning at least one LTS to the next (fixed at the start of M12 against the current release and recorded in the changelog with the date), `staging: config_first` (settings changes usually have to land before the code that depends on them), `seeded: django-tricky`.
   - `checks_hint`: the system check framework, a migrations check that fails if new migrations would be generated, and the test suite run with deprecation warnings treated as errors. These are hints the user copies into their own check config. The pack never runs them.
   - Trigger: "Use when planning a Django major or LTS upgrade in a Python repo." Built with the M3 generator and lint. `npm run pack:report -- django-upgrade` runs against the live official notes, and its output is attached to the pack PR.
3. **Django eval cases.**
   - Golden: at least 3 public Django upgrade PRs, with `checks` declared so M8 can run L1 on at least one, and all with an open licence. They must include:
     - **at least 2 strict LTS-to-LTS upgrades** (tag `lts-to-lts`). The M0 list has one (`django-ror-api-548`). `django-thunderstore-1369` lands on an LTS from a non-LTS release (`to-lts`, `docs/design.md` D4), so it counts towards the total but not towards these 2.
     - **at least 1 messy case** (tag `messy`): a reverted or partial Django upgrade, or one with follow-up fixes. The M0 list has none.

     Find candidates with `npm run cases:find` (M7) and vet them with the `add-golden-case` skill. If either kind can't be found, stop and raise it with the maintainer: it changes what the Django results can claim.
   - Seeded: `eval/seeded/django-tricky/`, with:
     - a removed setting in a split settings module
     - middleware referenced only by a dotted string
     - a removed template filter
     - a removed `Meta` option
     - a third-party app with an incompatible support range
     - a custom field overriding a changed method
     - a dynamic `import_module`
     - existing-state cases, with the same `expect` labels as M2: an API deprecated before the source release, never cleaned up and removed inside the range [`change`]; an import from a private or undocumented Django module [`change`]; a module already in the target form [`no_change`]; and decoys, old-style code the target still supports [`no_finding`]
   - The M3 lint applies unchanged: every reviewed Django rule reachable in the supported range needs a seeded case, and its match kind must be declared by the Django usage adapter. Many Django fixes come out `lands_on: source`, because the replacement usually exists a release or two before the removal.
   - Golden cases are picked for spread using the M7 coverage matrix (settings layout, monorepo or not, test runner, one LTS hop or more), not for count.
   - Recall is reported with the M2 recall script and ratcheted. Both packs appear in `eval/results.md`.
4. **Plugin bundle and README.** Regenerating the packs adds the Django skill to `plugin/` (generated, drift-checked). The README's eval table gains the Django rows copied from `eval/results.md`, and its limits change from one pack to two. Its status line belongs to M11 and does not change here.
5. **Publish v0.2 (D61).** After the pack PR merges, a release PR bumps the version in `package.json` to `0.2.0`. Then publish to npm under the name chosen in M10, tag `v0.2.0`, check the `npx` install on a clean machine or container for both the CLI and the MCP config, and publish the regenerated Claude Code plugin bundle, as M11 does for v0.1.

## Files and modules

`src/analysis/usages/django.ts`, `src/analysis/usages/registry.ts` (one added registry line; the registry file was added in M10's Core PR A, D57), `knowledge/pypi/django/**`, `packs/django-upgrade/**`, `eval/cases/<django ids>/**`, `eval/runs/<django ids>/**`, `eval/seeded/django-tricky/**`, `plugin/**`, `README.md`, `test/unit/djangoAdapter.test.ts`, and `package.json` (the version, in the release PR only).

## Tests

- **Django adapter:** one test per usage kind, and recall on `django-tricky` is recorded with a ratchet.
- **Pack:** the M3 lint and generator checks pass for the new pack, and pack versions are recorded per run.
- **No core changes:** `check-core-untouched` and `check-eval-add-only` pass for the pack PR, including on M0-style Django case folders with only `case.json` that the PR completes with `truth.json` and recorded runs. On planted changes one of them fails:
  - a file outside the allowlist, a second added line in `src/analysis/usages/registry.ts`, or a registry line swap (one added and one removed)
  - an edited or deleted file under `eval/history/`
  - an edited or deleted existing recorded run under `eval/runs/`, or a new recorded run added under an existing case
  - in an existing case's folder under `eval/cases/`: an edited file, an added file, a deleted file, or a deleted case folder
  - a case folder added for another pack, or runs added for, or completion of, a case of another pack
  - a changed pinned field in the `case.json` of a pending case the PR completes (a change to `notes` and `checks` only passes)
  - a deleted pending case folder, the pack's own or another pack's
  - an edited or deleted existing line of `eval/cases/README.md` (an added line passes)
  - a modified or deleted file under `test/` (an added file passes)
  - an `eval/cases/coverage-gaps.json` that drops a base entry not prefixed with this pack, or that is not a JSON array of strings on either side (adding or removing this pack's own entries passes)
  - a changed ratchet entry that existed on the base branch in `eval/seeded/ratchet.json` (a new entry that does not equal the measured recall fails `npm run recall -- --check --base`, INV-50)
- **Plugin:** the generated bundle matches the packs (drift check).
- **Regression:** the full eval reruns for both packs. The Next.js engine's worst-case pooled recall must not fall below the low end of its noise band in `eval/results.md` on the base branch, first recorded in M7. M7's CI pack gate checks this and the Django baseline comparison (D17): the engine's worst-case pooled recall (each Django case's lowest-recall run, pooled) must be above the baseline's best-case pooled recall (each case's highest-recall run, pooled). Every Django case has the same number N of recorded engine runs under HEAD's prompt version and the same N of baseline runs with HEAD's baseline prompt hash, with N at least 3, all made with the same host agent, and the gate fails on any other count. The Django pack has no band on the base branch, so it is beat-checked whichever PR adds its cases, and the regression check is skipped for it. A later PR that widens it is beat-checked again over all its cases.

## Acceptance criteria

- The Django pack, adapter and eval cases merge with `check-core-untouched` and `check-eval-add-only` passing.
- `eval/results.md` includes both packs and the baseline comparison, with misses listed, and an L1 run on at least one Django case. The Django pack beats the baseline on recall (`docs/design.md` D17).
- The Django golden set has at least 3 licensed cases, including at least 2 tagged `lts-to-lts` and at least 1 tagged `messy`, and `npm run cases:verify -- --all` passes.
- The README lists both packs with their eval numbers and claims only what exists.
- v0.2.0 is published to npm and tagged `v0.2.0`, and the `npx` install of the CLI and the MCP config works from a clean machine.

## Risks

- **A hidden core coupling surfaces** (for example, JS-specific assumptions in staging, packets or gate 7 test counting). Mitigation: that is exactly what this milestone tests. Fix it in a separate core PR and record it.
- **Django's string-based configuration hides usages from import graphs.** Mitigation: `string_ref` edges from M2, settings parsing, and seeded cases for each pattern.
- **Django tests need a database or other services.** Mitigation: the user declares them in their checks (for example a SQLite test settings module), and missing services show up as baseline failures. Container mode was cut in v0.1 (`docs/design.md` D42), so no image can be supplied; the README states this limit.
- **Neither M0 Django case's declared checks can run at L1 as written.** `django-ror-api-548` runs `python manage.py setup $TEST_DATA_DUMP_FILE -t`, but L1 runs checks as argv with no shell and a scrubbed environment, so the variable is neither expanded nor set. `django-thunderstore-1369` runs its tests through `docker compose`, and container mode is cut (D42). Mitigation: the L1 acceptance above likely needs a new Django case whose checks run as argv in a clean environment; look for one while finding the task 3 cases, and raise it with the maintainer if none can be found.

## Dependencies

- M11 (v0.1 published, and the release steps v0.2 repeats), M10 (the "no core changes" check, the L1 eval evidence, the plugin bundle, the name), M3 (pack tooling), M2 (the adapter interfaces and Python adapter), M7 (the eval harness), M8 (checks, codemod registry, gate 7).

## Must not break

The Next.js pack results, all gates including gate 7, the permissions suite, prompt immutability and the repo hash.
