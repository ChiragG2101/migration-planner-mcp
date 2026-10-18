# M10 - Django pack, AGENTS.md snippet, README, open-source files, demo, name

**PRD refs:** sections 4 (scope, pack 2), 9 (packs and skills), 14 (demo, README, snippet, open source). **Done when:** the Django pack is added with **no core changes**, and the README states its limits and claims only what exists.

## Scope

- In scope:
  - the Django LTS to LTS upgrade pack, its usage adapter, generated skill and references
  - Django eval cases (golden and seeded)
  - the AGENTS.md snippet reader at ingest, including declared checks
  - the open-source files: `CONTRIBUTING.md`, `AI_POLICY.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates
  - the Claude Code plugin bundle (generated skills plus the MCP config)
  - the final README
  - the 60 to 90 second demo
  - the final name
- Out of scope: npm publish and tagging (M11), third-party packs loaded from outside the repo, and other languages.
- Cut order: if behind, the Django pack keeps its golden cases and the "no core changes" check, but ships fewer rules. The README, snippet, open-source files and demo still ship.

## Why Django is pack 2

It is a different language, package manager, test runner and project layout from pack 1. If the engine built for Next.js handles it with only pack data and one usage adapter, the engine is general. If it can't, this milestone finds out where it isn't, which is the point.

## "No core changes" definition

Adding the pack may only touch:

- `knowledge/pypi/django/**` and `packs/django-upgrade/**`
- one new usage adapter `src/analysis/usages/django.ts`, registered with one line in `src/analysis/usages/index.ts`
- eval cases and fixtures
- docs

The Python language adapter (M2), the text scanner (M2), the staging options (M6) and the `django-upgrade` codemod registry entry (M8) already exist, so none of them count as changes here.

A CI check (`scripts/check-core-untouched.ts`) diffs the pack PR against the protected paths: `src/core/**`, `src/lang/**`, `src/pipeline/**`, `src/rules/**` (loader, version schemes, composition), `src/schema/**` (including the match kinds), `src/security/**`, `src/store/**`, `src/verify/**` and `src/tools/**`, other than the registry line. It fails on any change. If the pack cannot be added without a core change, that is a design bug. Fix it in a separate, reviewed core PR **before** the pack PR, and record the fix in `docs/design.md`.

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
   - `pack.json`: `kind: upgrade`, primary library `pypi/django`, `supported` spanning at least one LTS to the next (fixed at the start of M10 against the current release and recorded in the changelog with the date), `staging: config_first` (settings changes usually have to land before the code that depends on them), `seeded: django-tricky`.
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
4. **AGENTS.md snippet (separate core PR).**
   - `examples/AGENTS.snippet.md`: a short fenced block under a `## migration-planner` heading (renamed with the final name) with these keys:
     - `checks`: `install` plus named checks
     - `planner_deny`: a list of globs
     - `targets`: for example `next@16` or `django@5.2`
   - Reader (`src/pipeline/agentsSnippet.ts`, called from ingest). It reads `AGENTS.md` at the repo root via `SafePath`, if present, and parses only the fenced block under that heading.
     - `planner_deny` globs are **added** to the deny list. A glob that tries to un-deny (for example `!.env`) or point outside the root is rejected and logged.
     - `checks` become a second source for M8's check config. The repo's own file may have been written by someone else, so checks from the snippet are printed at startup and are used only with `--trust-repo-checks`. CLI flags always win.
     - `targets` is checked against the user's request. A mismatch produces an ambiguity question, not a silent override.
   - The engine works without it, and its absence is logged as "AGENTS.md snippet: not found".
   - This touches `src/pipeline/ingest.ts`, `src/security/denyList.ts` and `src/verify/checks.ts`. Because it is a core change, it lands in its own PR, separate from the Django pack PR, so the "no core changes" check stays meaningful for the pack.
5. **Open-source files.**
   - `CONTRIBUTING.md`: packs are the unit of contribution. A pack PR must include its rules, generated skill, at least 2 golden cases, a seeded repo and an eval run against the baseline. CI's eval and the pack lint are part of review. Core changes need an issue first.
   - `AI_POLICY.md`: AI-assisted contributions are welcome when disclosed in the PR. The human contributor is responsible for every change and must be able to explain it. AI is never listed as an author.
   - `SECURITY.md`: how to report a sandbox, path-boundary or exec issue privately.
   - `CODE_OF_CONDUCT.md` and issue templates (bug, pack request with demand evidence, golden-case submission).
6. **Plugin bundle (`plugin/`).** A Claude Code plugin that installs the generated skills for both packs and the MCP server config, plus a Cursor config snippet. It is generated from the packs (no hand-written copies), and the pack lint covers it.
7. **Name.** Choose the final name. Criteria:
   - it says "migration" or "upgrade", not "MCP"
   - it is free on npm and GitHub
   - it is short enough to type as a CLI command

   Record the decision in `docs/design.md`, and update the binary name, the snippet heading, the plugin and the docs. The repo rename happens in M11.
8. **README (final):**
   1. pitch
   2. demo GIF
   3. one-snippet install (CLI, Claude Code plugin, Cursor)
   4. example output (an excerpt from a real `MIGRATION_PLAN.md` and a verify report)
   5. how it works (the PRD section 6 diagrams)
   6. eval table per pack with the baseline comparison, copied from `eval/results.md` with the misses linked
   7. **Limits:**
      - TS/JS and Python only
      - two packs, single repo
      - never writes to your repo
      - L1 runs your declared checks in a sandbox copy; the clone sandbox is not a security boundary
      - the engine cannot stop your agent's own tools from editing your repo
      - no third-party packs
   8. how to add a pack (link to `CONTRIBUTING.md`)
   9. companions (GitHub MCP, filesystem MCP, git MCP), with links checked against current docs

   The status stays "currently building" until M11 (C8).
9. **Demo (60 to 90 seconds; `docs/demo/script.md` plus a recorded GIF or MP4).** Show Claude Code on a real Next.js repo on an older major:
   1. `git status` is clean
   2. ask for a plan
   3. show `validate_plan` rejecting a draft for an uncited claim (gate 3) or an evidence mismatch (gate 1)
   4. show the passing plan with file:line links and the "Needs human decision" section
   5. run one stage at L1 and show gate 7 rejecting a patch that skipped a failing test, then the corrected patch being kept
   6. `git status` is still clean, and the repo hash matches

   Script it so it can be reproduced.

## Files and modules

`src/analysis/usages/django.ts`, `src/analysis/usages/index.ts` (one registry line), `knowledge/pypi/django/**`, `packs/django-upgrade/**`, `eval/cases/<django ids>/**`, `eval/seeded/django-tricky/**`, `scripts/check-core-untouched.ts`, `src/pipeline/agentsSnippet.ts`, plus `src/pipeline/ingest.ts`, `src/security/denyList.ts` and `src/verify/checks.ts` (separate PR), `examples/AGENTS.snippet.md`, `CONTRIBUTING.md`, `AI_POLICY.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`, `plugin/**`, `README.md`, `docs/demo/{script.md,demo.gif}`, `test/unit/{djangoAdapter,agentsSnippet}.test.ts`, `test/permissions/{agents-snippet-cannot-widen,repo-checks-need-trust}.test.ts`.

## Tests

- **Django adapter:** one test per usage kind, and recall on `django-tricky` is recorded with a ratchet.
- **Pack:** the M3 lint and generator checks pass for the new pack, and pack versions are recorded per run.
- **No core changes:** `check-core-untouched` passes for the pack PR.
- **AGENTS.md snippet:**
  - It parses only the dedicated block.
  - `planner_deny` adds entries.
  - Permissions: `!.env`, `../outside` and absolute paths are rejected, and the boundary is unchanged (`agents-snippet-cannot-widen`).
  - Checks from the snippet are ignored without `--trust-repo-checks`, and CLI flags override them (`repo-checks-need-trust`).
  - A missing file is handled.
- **Plugin:** the generated bundle matches the packs (drift check).
- **Regression:** the full eval reruns for both packs. Next.js results must not regress beyond the noise band recorded in M7.

## Acceptance criteria

- The Django pack, adapter and eval cases merge with `check-core-untouched` passing.
- `eval/results.md` includes both packs and the baseline comparison, with misses listed, and an L1 run on at least one Django case.
- The Django golden set has at least 3 licensed cases, including at least 2 tagged `lts-to-lts` and at least 1 tagged `messy`, and `npm run cases:verify -- --all` passes.
- The AGENTS.md snippet works when present, is optional, provably cannot widen the boundary, and cannot add checks without the trust flag.
- The open-source files and plugin bundle exist, and the README follows the order above, states its limits and claims only what exists.
- The demo script reproduces the reject-then-pass flow, the gate 7 rejection and a clean `git status`.
- The final name is recorded in `docs/design.md`.

## Risks

- **A hidden core coupling surfaces** (for example, JS-specific assumptions in staging, packets or gate 7 test counting). Mitigation: that is exactly what this milestone tests. Fix it in a separate core PR and record it.
- **Django's string-based configuration hides usages from import graphs.** Mitigation: `string_ref` edges from M2, settings parsing, and seeded cases for each pattern.
- **Django tests need a database or other services.** Mitigation: the user declares them in their checks; container mode (M8) lets them supply an image; missing services show up as baseline failures.
- **AGENTS.md as an injection vector** (instructions or commands in the file). Mitigation: only three structured keys are parsed, the rest of the file is ignored, deny entries can only restrict, and checks need the trust flag.
- **The demo overstates capability.** Mitigation: use a real repo, show unresolved and needs-human items honestly, and put no metrics on screen that are not in `eval/results.md`.

## Dependencies

- M3 (pack tooling), M2 (the adapter interfaces and Python adapter), M7 (the eval harness), M8 (checks, codemod registry, gate 7), M9 (needs-human section and report for the demo), M1 (deny list and boundary for the snippet).

## Must not break

The Next.js pack results, all gates including gate 7, the permissions suite (with the new snippet tests), prompt immutability and the repo hash.
