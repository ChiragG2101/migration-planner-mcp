---
name: add-golden-case
description: Use when finding, vetting or adding a golden eval case (a real public migration PR used as ground truth) under eval/cases/. It covers picking a good PR, pinning commits and deriving truth.json.
---

# Add a golden case

A golden case is a real public migration PR. The planner runs on the commit before it, and its output is scored against what the PR actually changed. Bad cases make the eval lie, so vet hard.

This skill is for contributors to this repo. Users of the engine never see it; their feedback reaches the eval through `record_feedback` and a maintainer's review.

## 1. Find candidates

- Once it exists (M7), run `npm run cases:find -- <pack> --from <v> --to <v>`. It searches GitHub, runs the mechanical checks below, and writes candidates with a vetting report to `eval/.work/candidates/`, each marked with the coverage-matrix cell it would fill. It never adds a case by itself.
- By hand: search GitHub for merged PRs whose title names the migration, for example `is:pr is:merged in:title upgrade "next 16"`. Exclude bots (`-author:app/dependabot -author:app/renovate`). With the `gh` CLI, pace searches to about one every 7 seconds. GitHub's secondary rate limit blocks fast loops.
- Prefer repos with an open licence, a real test suite and CI, and a PR that does mostly the migration. Prefer candidates that fill an empty cell of the coverage matrix in `eval/cases/README.md` over ones that repeat a covered shape.

## 2. Vet each candidate

Accept a PR only if all of these hold:

- [ ] The repo is public and its licence allows cloning and analysis.
- [ ] The PR is merged and the base commit (its parent) can be checked out.
- [ ] Most changed files are migration changes. Large unrelated refactors make ground truth noisy; note any exclusions.
- [ ] The source and target versions are clear from the lockfile diff (not the PR title).
- [ ] The base commit is the merge commit's first parent (or only parent).
- [ ] For L1 cases: the test suite runs from a clean clone with commands you can write down, with no secrets needed.

Keep a few **messy cases** on purpose: a partial migration, a reverted PR, or a PR with follow-up fixes. Each pack needs at least one, tagged `messy`.

## 3. Record it

Create `eval/cases/<id>/case.json`:

- `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`
- `source` and `target` with versions
- `checks`: the install and check commands, for L1 cases
- `tags` (for example `messy`, `monorepo`)
- `notes`: why this case was chosen, and any manual exclusions with the reason

Add a line to `eval/cases/README.md`.

## 4. Derive the truth

- Run the truth-derivation script (`scripts/derive-truth.ts`, from `docs/plans/07-*`). It diffs base against merge and maps changed hunks to usages at base, writing `truth.json`.
- Never hand-edit `truth.json`. Exclusions go in `case.json` `notes` and are applied by the script.
- Checkouts happen in the eval workspace (`eval/.work/`, gitignored), never in the engine's view of a user repo.

## 5. Record its runs

The pack gate scores recorded runs, so a case without them is not done (`docs/design.md` D17; the eval section of the `add-pack` skill).

- Record N engine runs and N baseline runs under `eval/runs/<id>/`, with N equal to the N the pack's existing cases have on both sides (at least 3).
- Engine runs use HEAD's prompt version (`prompts/manifest.json`), baseline runs HEAD's `eval/baseline/prompt.md`, and every run the same host product and model as the pack's other runs.
- A case committed before its pack exists is pending: it has no runs and is listed as pending in `results.md`. The PR that adds the pack completes it by adding files and changing only `notes` and `checks` in `case.json`; the pinned fields (`id`, `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`, `source`, `target`, `tags`, `license`) stay byte-identical.
- Once a case has recorded runs it is an existing case, and it is add-only on every PR: no file in its folder is added, changed or deleted (except that `annotations.json` may gain appended entries; its existing entries are frozen), and the folder is not deleted; no recorded run is changed or deleted; and no run is added to a set that already has runs (runs under a new prompt version, in a core PR, and a case's first L1 set are plain adding). The only exceptions are `docs/design.md` D15's: (a) a core PR that changes `eval/baseline/prompt.md` replaces every pack's baseline runs and nothing else, and (b) a case is removed with all its runs in a core PR that adds an entry to `eval/cases/REMOVED.json`. A core PR changes nothing under `packs/` or `knowledge/`, and a maintainer's code-owner review is required for `eval/cases/**` and `eval/runs/**`. `truth.json` is never re-derived for it, and replacing a broken case goes through exception (b).

## 6. Check it works

- Run `npm run cases:verify -- <id>` (from M7). It re-checks the commits, parentage, versions, licence and test command against GitHub.
- Run the eval for this case only (`--case <id>`) in replay or live mode. Confirm the repo hash is unchanged and the metrics are populated.
- Look at the misses. A miss that comes from bad ground truth means fixing the case notes before the case and its runs merge (afterwards only the case-removal path can replace it); a real miss is a finding about the engine. Don't tune the case to make the engine look good.
