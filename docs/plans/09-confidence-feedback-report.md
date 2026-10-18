# M9 - Confidence routing, record_feedback, run report, checklists, budget

**PRD refs:** sections 3 (selectivity), 6.6 (emit), 7 (confidence routing, audit trail, feedback loop), 8 (Emit row), 10 (calibration). **Done when:** the needs-human section works, and every number in the run report traces to events.

## Scope

- In scope:
  - deterministic confidence routing into a "Needs human decision" section
  - "Review first" for high and blocker findings with source `agent_judgment`, and for L1 stages that gate 7 sent to review (M8)
  - per-stage checklists, written as part of the normal L0 emit
  - `run_report.md`, including a verify section when L1 ran
  - a time and token budget per run
  - `record_feedback`, which turns feedback into eval cases
- Out of scope: L2 (writing to the user's repo) is not built in v0.1, and `--level 2` stays refused.
- None of this is cut if behind. Routing, the report and feedback are what make the output trustworthy to read.

## Tasks

1. **Routing (`src/pipeline/routing.ts`).**
   - `threshold` comes from config (`--confidence-threshold`, default `0.6`). Its value and source are recorded per run.
   - Rules, in order:
     1. `severity ∈ {high, blocker}` with `source = agent_judgment` goes to **"Review first"** at the very top, regardless of confidence. L1 stages whose patch is in `patches/needs-review/` (gate 7) also go here, with the gate 7 reason. So does every usage the user's scope excluded whose rule has `necessity: breaks` (derived per run by M3's composition), with the line "excluded by your scope, but this breaks on the target". So does every usage a lens marked out of scope whose rule `breaks`, with the line "marked as needing no change, but this rule breaks on the target" (`docs/design.md` D16).
     2. `confidence < threshold` goes to **"Needs human decision"**, not the main plan.
     3. Everything else goes into the main plan stages.
     4. "Docs unverified" findings (M4) get a visible badge wherever they land.
   - Routing is deterministic and runs after `validate_plan`. A routed finding still has to pass the gates (routing is not a bypass).
   - Use `eval/calibration.csv` from M7 to propose a tuned threshold. Write the analysis to `eval/threshold.md`. Change the default only with that evidence (PRD section 7: "not by feel").
2. **Emit update (`src/pipeline/emit.ts`).** `MIGRATION_PLAN.md` order:
   1. "Review first"
   2. "Unresolved" (from M6, and unresolved L1 stages from M8)
   3. "Needs human decision"
   4. a per-stage summary of 1 or 2 templated lines each, with the L1 decision when verify ran
   5. stage details
   6. footer (pack, prompt and gate versions, the threshold, and the repo-untouched line)

   Keep the prose minimal and templated so it doesn't get padded (failure matrix: Emit).
3. **Checklists (`src/pipeline/checklists.ts`).** Part of the L0 emit, since they are output files and need no extra autonomy. Per stage, `<out>/<run_id>/stages/<n>/CHECKLIST.md`: the codemods to run, then each manual finding's action, verify and rollback, and the pack's `checks_hint`. Written via `safeWrite`.
4. **`run_report.md` (`src/pipeline/report.ts`).** Written next to the plan. It contains:
   - inputs, campaign and repo IDs, and resolved versions
   - pack, prompt and codemod-registry versions
   - size and scope: the computed size with its reasons, each scope question with its answer (marked when it was a default), and the usages each answer excluded
   - coverage (usages found, covered, out of scope with reasons split by `written_by`, uncovered)
   - unparsed and skipped files
   - docs status (fresh, stale or unverified counts, and fallback events), split by `fetched_by` (engine, agent or knowledge) and `official` (M4), with the plain note that agent-registered docs are checked for source, not content
   - gate results per round
   - **verify (only when L1 ran):** the baseline results, per-stage decision and attempts, checks with durations, gate 7 results, flaky checks, every command run with its exit code, the steps that used the network, and the exact `git apply` command for the kept patches
   - what was dropped and why (dedupe merges, lens gaps, budget cuts)
   - the per-step cost (tokens if reported) and time
   - a "target repo untouched" line with the before and after hashes

   Everything is generated from the event spine. Nothing is held only in memory.
5. **Budget (`src/pipeline/budget.ts`).** Time and token budget per run (`--budget-tokens`, `--budget-seconds`). When the budget is exceeded, the remaining lenses or stages are recorded as `budget_cut` and shown in the report. Nothing is silently skipped.
6. **`record_feedback` (core, tool `src/tools/recordFeedback.ts`, CLI `feedback`).**
   - Input: `run_id`, `finding_id?` or `stage_id?`, `kind` (`wrong`, `missing`, `severity_wrong`, `bad_patch` or `other`), `note`, and optional `file` and `line` for `missing`.
   - Stores to `feedback` (migration `006_feedback.sql`) with the run.
   - Exports to `eval/feedback/<run_id>-<n>.json` under the output dir, in a format `eval/runner.ts` can turn into a seeded case or a golden-case annotation. `scripts/feedback-to-case.ts` is manual and reviewed.
   - No training and no network.
   - For `missing`, the file and line go through `SafePath` (the user cannot point outside the repo).

## Files and modules

`src/pipeline/{routing,report,budget,checklists}.ts`, `src/pipeline/emit.ts` (updated), `src/core/recordFeedback.ts`, `src/tools/recordFeedback.ts`, `src/cli/feedback.ts`, `src/store/feedback.ts`, `src/store/migrations/006_feedback.sql`, `scripts/feedback-to-case.ts`, `eval/threshold.md`, `test/unit/{routing,report,budget,feedback,checklists}.test.ts`.

## Tests

- **Routing:** a table test across confidence 0.59, 0.6 and 0.61; each severity; and each source. An agent-judgment blocker at confidence 0.95 still goes to "Review first". A gate 7 needs-review stage goes to "Review first". A usage excluded by scope whose rule `breaks` goes to "Review first", and one whose rule is only `deprecated` does not. A usage a lens marked out of scope whose rule `breaks` also goes there. A custom threshold is respected and recorded.
- **Emit order:** a golden-file test of section order for a mixed plan, with and without L1 results. The needs-human section is present only when it is non-empty.
- **Checklists:** one per stage, codemods listed before manual steps, written only under `<out>/<run_id>/stages/`.
- **Report:** every number in `run_report.md` traces to events. A test rebuilds the report from fixture event logs, one L0 and one L1.
- **Budget:** exceeding the budget gives a `budget_cut` entry in the report, and nothing is missing silently.
- **Feedback:** stored with the run, exported to the output dir, and a `missing` entry with `../` is rejected.
- **Permissions:** the full suite, including the M8 exec tests. Checklists and reports are written only under `<out>/<run_id>/`, and the repo hash is unchanged.

## Acceptance criteria

- On a golden case, `MIGRATION_PLAN.md` shows "Review first" and "Needs human decision" populated according to the rules, and `run_report.md` is complete.
- On an L1 golden case, the report's verify section matches `verify_report.json` and the events.
- `record_feedback` creates a stored entry and an exportable eval-case file.
- The eval rerun (required, since routing affects the plan) is published in `eval/results.md`.

## Risks

- **Threshold misuse**, where a low threshold hides uncertain findings in the main plan. Mitigation: evidence-based tuning only, and the threshold is printed in the plan footer.
- **"Review first" bloat** if the agent overuses `agent_judgment` high findings. Mitigation: report the count, and M7 tracks the false-alarm rate.
- **Report too long to read.** Mitigation: a short summary block at the top of `run_report.md`, with the detail below it.

## Dependencies

- M6 (plans, gates, emit), M7 (calibration data, eval rerun), M8 (verify results and gate 7 review items), M1 (`safeWrite`).

## Must not break

All gates including gate 7, the eval smoke, the permissions suite and the repo hash.
