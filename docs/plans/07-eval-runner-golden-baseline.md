# M7 - Eval runner, 5 golden cases, baseline run

**PRD refs:** section 10 (tiers, metrics, regression rule), section 12 (eval smoke in gates), section 15 (honest claims). **Done when:** `eval/results.md` is published, misses included.

## Scope

- In scope:
  - a local eval runner that is free to run
  - 5 golden cases (real public Express to Hono migrations, including at least 1 messy or failed one)
  - the seeded-defect tier from M2
  - a baseline run of the same host agent without the server
  - all PRD section 10 metrics, including the repo-untouched hash and cost and time
  - the regression rule wired into CI
- Out of scope: the stretch ordering check (applying stages on a branch). That needs execution and is deferred. If it is attempted later, it runs on a **copy** of the repo, outside the server, as part of eval tooling only.

## Tasks

1. **Case format (`eval/cases/<id>/case.json`).**
   - Fields: `repo_url`, `base_commit` (the parent of the migration), `merge_commit`, `pr_url`, `source`, `target`, `notes` and `tags` (for example `messy` or `monorepo`).
   - Ground truth is derived deterministically. `scripts/derive-truth.ts` diffs base against merge and maps the changed hunks to M2 usages at base, writing `truth.json` (true changed usages, touched files, and per-file edit size, which is used for severity calibration).
   - The diff and checkout are done by **eval tooling**, outside the MCP server, in a temp clone under the eval workspace. The server only ever sees a read-only path (C3 still holds for the server).
2. **Pick and pin 5 cases.** Extend the M0 list to 5, with at least one messy case: a partial migration, a reverted PR, or a PR with follow-up fixes. Record why each was chosen.
3. **Runner (`eval/runner.ts`).**
   - Modes:
     - `--tier unit|seeded|golden|baseline|all`
     - `--smoke`: the seeded tier plus 1 golden case, used in milestone gates
     - `--case <id>`
   - For each case: clone or fetch into `eval/.work/<id>` (gitignored), check out the base commit, record `repo_hash_before`, drive the planner, then record `repo_hash_after`. A mismatch fails the case outright.
   - **Driving the host agent at zero cost.** The default is a *replay* mode: it re-scores recorded transcripts and findings (`eval/runs/<case>/<prompt_version>/`) produced by running the flow in Claude Code or Cursor under the user's existing subscription. A *live* mode uses the optional CLI with the user's own API key (PRD section 1). It is opt-in and reports token cost. The runner never needs a paid service by default (C1). **Decision to record:** how live runs are triggered for each host. Claude Code headless (`claude -p`) is the likely candidate; check the current docs at M7 start.
4. **Baseline (`eval/baseline/`).** The same host agent and the same task prompt text, but with **no** MCP server configured. Ask for a plan in Markdown and parse it into best-effort findings (file:line mentions, severities) using `eval/baseline/parse.ts`. Score it with the same metrics. Citations that don't resolve count as invalid, not as skipped.
5. **Metrics (`eval/metrics.ts`).**
   - usage recall (true changed usages covered)
   - file precision (listed files that the real PR also touched)
   - evidence validity (share of resolving citations, with a target of 100%)
   - severity calibration (the share of high and blocker findings whose files needed non-trivial edits, with the threshold defined in code)
   - the false-alarm rate for high and blocker findings
   - the `out_of_scope` rate
   - unresolved count
   - cost (tokens if reported) and wall time
   - repo-untouched (bool)
6. **Results (`eval/results.md`, generated).** One table per tier: case × metric, plus a **with server vs. without** comparison table. It includes a "Misses" section listing every false negative and false alarm with a link, and records the versions of the pack, prompt, gates (a code hash) and server. History is kept in `eval/history/<date>-<git-sha>.json`.
7. **Regression rule in CI.** A path filter on `prompts/`, `rules/`, `rules/**/SKILL.md` and `src/pipeline/gates/` requires `eval/results.md` to be regenerated in the same PR (CI checks that the results' recorded version hashes match HEAD). The smoke tier runs on every PR in replay mode, offline and for free.
8. **Threshold tuning input.** Export the per-finding confidence vs. correctness pairs to `eval/calibration.csv`. M8 uses them to tune the 0.6 threshold.

## Files and modules

`eval/runner.ts`, `eval/metrics.ts`, `eval/baseline/{prompt.md,parse.ts}`, `eval/cases/<5 ids>/{case.json,truth.json}`, `scripts/derive-truth.ts`, `eval/results.md`, `eval/history/`, `eval/calibration.csv`, `.github/workflows/ci.yml` (or a local `npm run ci` if CI is not used), `test/unit/eval/*.test.ts`.

## Tests

- **Metrics:** unit tests with hand-computed fixtures for recall, precision, calibration and false-alarm rate.
- **Truth derivation:** a tiny synthetic repo with two commits gives the expected `truth.json`.
- **Repo-untouched:** the runner fails a case when the target hash changes. Tested by planting a write in a fake planner, which must be caught.
- **Replay determinism:** re-scoring the same recorded run twice gives byte-identical metrics.
- **Baseline parser:** extracts file:line and severity from sample Markdown, and unresolvable citations are counted as invalid.
- **Permissions:** the full suite, still in the gate.

## Acceptance criteria

- `npm run eval -- --tier all` (replay mode) produces `eval/results.md` with 5 golden cases, the seeded tier and the baseline comparison, all metrics populated, and misses listed.
- Every case reports `repo_untouched: true`.
- Evidence validity for the server is 100%, because the gates enforce it. If it isn't, that is a bug filed before M7 closes.
- `results.md` states plainly where the server does **not** beat the baseline.

## Risks

- **Finding 5 good migrations takes time (PRD section 16).** Mitigation: the search started in M0. A messy case is acceptable, and it is also required.
- **Ground truth is noisy.** Real PRs include unrelated refactors. Mitigation: `truth.json` excludes files with no source-library usage at base, and `notes` record any manual exclusions with a reason.
- **Variance in the host agent between runs.** Mitigation: record the transcripts and report the spread over N runs when using live mode. Replay keeps CI deterministic.
- **Cost.** Mitigation: replay is the default, and live runs are opt-in on the user's own key with costs reported.

## Dependencies

- M6 (an end-to-end plan), M2 (the seeded repo and recall), M0 (the case list).

## Must not break

Gates, permissions, pack lint and prompt immutability.
