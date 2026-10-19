---
name: add-pack
description: Use when adding a new migration pack under packs/, or widening an existing pack's checked range to a new release. It walks the contribution path from pack.json and knowledge to eval results without touching the engine core.
---

# Add a migration pack

A pack is data plus one usage adapter. The facts live in `knowledge/`, per library and per release; the pack only says which libraries to use and how to plan with them (`docs/design.md` D10). If adding a pack needs an engine change, that is a design bug, fixed in a separate core PR first (see `docs/plans/10-*`, "No core changes").

## 0. Before you start

- Packs only come from the repo's own `packs/` and `knowledge/` folders; third-party packs are not supported in v0.1.
- Check demand: open an issue with the pack-request template, including evidence that people actually do this migration (for example merged PR counts or survey data).
- Check the language is supported by an existing adapter in `src/lang/` (TS/JS and Python in v0.1), and that the version scheme and match kinds you need exist in the core. If not, that is a core change, not a pack.
- Read `docs/plans/03-*` (knowledge and pack schema, composition, generator, lint) and `docs/plans/10-*` (how the Django pack was added).

## 1. Knowledge first

- Every library the pack uses needs knowledge for every release in the range you want to support. Add missing releases with the `add-release-knowledge` skill, one release per PR.
- Widening an existing pack to a new release is mostly this step, plus a `supported` bump.

## 2. Write `packs/<pack>/pack.json`

- `kind: upgrade` for the same library across versions (Next.js 15 → 16), or `kind: swap` for one library to another (Jest → Vitest).
- `libraries[]`: one `primary`, plus `companion` libraries whose range follows from the primary's peer requirements.
- `supported {from, to}`: only releases whose knowledge is reviewed. Record the date in `CHANGELOG.md`.
- `staging: leaf_first` (code first, leaves before importers) or `config_first` (settings first).
- `usage_adapter`, `usage_kinds[] {kind, lens}`, `checks_hint`, `trigger`.
- `seeded`: the name of the pack's seeded repo under `eval/seeded/` (for example `next-tricky`).

Never put commands, scripts or shell snippets in a pack. Only `checks_hint` may look like a command, and it is display text.

## 3. Usage adapter

- Add `src/analysis/usages/<pack>.ts` implementing `UsageAdapter`, declare its `match_kinds[]`, and register it with **one line** in `src/analysis/usages/index.ts`.
- Label anything found by name only, not by resolved import, as `confidence: heuristic`.
- Unit-test each usage kind with a small inline fixture (use the `write-tests` skill).

## 4. Generate and lint

- Run `npm run build:packs` to produce `SKILL.md` and `references/`. Never edit generated files by hand.
- The skill's trigger is one sentence: "Use when planning a <migration> in a <language> repo." No broad phrases.
- Run the pack lint (`npm run lint`). It checks the trigger, line limit, references, codemod IDs, versions and changelogs, the match kinds your adapter declares, seeded coverage of every reachable rule, and that there are no non-data files.

## 5. Eval

- Seeded repo `eval/seeded/<name>/`, the one `pack.json` names in `seeded`, with planted hard cases and `ground_truth.json` (each `expect: change` entry names its `rule_id`). Report recall with the recall script and add the pack's entry to `eval/seeded/ratchet.json`.
- At least **2 golden cases** from real public PRs: find candidates with `npm run cases:find` and vet them with the `add-golden-case` skill. Declare `checks` so L1 can run on at least one.
- Run the eval for the new pack and for every existing pack. Replay feeds your recorded lens submissions through the current engine and never calls a model, so a recorded finding the engine no longer accepts counts as a miss. Only engine runs under the current prompt version in `prompts/manifest.json` count. Every baseline run records its hash of `eval/baseline/prompt.md`, and one with a hash other than HEAD's fails the gate. Every case of a pack has the same number N of engine runs and the same N of baseline runs, at least 3, under `eval/runs/<case>/`, all made with the same host product and model (each run records them; the CLI version may differ). CI's pack gate fails on any other count, and on a pack with fewer than 2 golden cases or no true changed usage.
- A pack with no band in `eval/results.md` on the base branch must beat the baseline, whichever PR adds its cases: its worst-case pooled recall (each case's lowest-recall engine run, pooled over the pack's cases) must be above the baseline's best-case pooled recall (each case's highest-recall baseline run, pooled the same way). CI's pack gate checks it (`docs/design.md` D17). If it doesn't, the pack isn't ready: raise it with the maintainer rather than tuning the eval or the baseline.
- Existing packs must not regress: each pack's engine worst-case pooled recall, over the cases in its base band, must stay at or above the low end of that band in `eval/results.md` on the base branch.
- Widening an existing pack with new golden cases: give each new case the same N as the pack's existing cases. The regression check leaves the new cases out, but the pack must still beat the baseline over all its cases, new ones included (for `nextjs-upgrade`, exempt since M7, the result is shown in `results.md` but not enforced). The new cases' runs join the pack's band in your regenerated `results.md`.
- Cases committed before their pack existed (such as M0's Django cases) have no recorded runs and are listed as pending. Your pack PR completes its own pack's pending cases (a case's pack is the `pack` field of its `case.json`) by adding files and changing only `notes` and `checks` in `case.json` (the pinned fields `id`, `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`, `source`, `target`, `tags` and `license` stay byte-identical), and records their runs. Never add, complete or record runs for another pack's case. Add a line for each new case to the coverage matrix in `eval/cases/README.md`; that file is eval data your PR may add lines to, but not edit or delete existing ones. Your PR may never remove a pending case, your own pack's or another's; that goes through D15's exception (b) in a core PR.
- An existing case is one with recorded runs on the base branch. On every PR, `scripts/check-eval-add-only.ts` checks that no file in its folder is added, changed or deleted (except that `annotations.json` may gain appended entries; its existing entries are frozen), and the folder is not deleted; no recorded run is changed or deleted; and no run is added to a set that already has runs (runs under a new prompt version, in a core PR, and a case's first L1 set are plain adding). The only exceptions are `docs/design.md` D15's: (a) a core PR that changes `eval/baseline/prompt.md` replaces every pack's baseline runs and nothing else, and (b) a case is removed with all its runs in a core PR that adds an entry to `eval/cases/REMOVED.json`. A core PR changes nothing under `packs/` or `knowledge/`, and a maintainer's code-owner review is required for `eval/cases/**` and `eval/runs/**`.

## 6. Open the PR

- The `check-core-untouched` and `check-eval-add-only` checks must pass. It allows only the pack's knowledge and pack folders, the adapter and its registry line, eval data (where existing cases and recorded runs are add-only), tests, docs and regenerated outputs (see `docs/plans/10-*`).
- Attach the output of `npm run pack:report -- <pack>` and explain every "missing" item.
- The PR description lists the libraries and range, the codemods used, and the eval table, with the misses.
- Disclose AI assistance as `AI_POLICY.md` asks.
