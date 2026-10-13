# M8 - Confidence routing, record_feedback, run report, output flags (L1 behind --level 1)

**PRD refs:** sections 3 (autonomy ladder), 6.6 (`run_report.md`), 7 (confidence routing, audit trail, feedback loop), 7A (autonomy flags), 8 (Emit row). **Done when:** the needs-human section works and L1 is refused without the flag.

## Scope

- In scope:
  - deterministic confidence routing into a "Needs human decision" section
  - "always show first" for high and blocker findings with source `agent_judgment`
  - `record_feedback`, which turns feedback into eval cases
  - `run_report.md`
  - L1 output (per-stage checklists and test stubs), written **only** to the output dir and **only** with `--level 1`
- Out of scope: L2 (branches) is not built in v0.1. `--level 2` stays refused.
- Cut order: L1 output is the **first** thing cut if behind. The routing, feedback and report are not cut.

## Tasks

1. **Routing (`src/pipeline/routing.ts`).**
   - `threshold` comes from config (`--confidence-threshold`, default `0.6`). Its value and source are recorded per run.
   - Rules, in order:
     1. `severity ∈ {high, blocker}` with `source = agent_judgment` goes to **"Review first"** at the very top, regardless of confidence.
     2. `confidence < threshold` goes to **"Needs human decision"**, not the main plan.
     3. Everything else goes into the main plan stages.
     4. "Docs unverified" findings (M4) get a visible badge wherever they land.
   - Routing is deterministic and runs after `validate_plan`. A routed finding still has to pass the gates (routing is not a bypass).
   - Use `eval/calibration.csv` from M7 to propose a tuned threshold. Write the analysis to `eval/threshold.md`. Change the default only with that evidence (PRD section 7: "not by feel").
2. **Emit update (`src/pipeline/emit.ts`).** `MIGRATION_PLAN.md` order:
   1. "Review first"
   2. "Unresolved" (from M6)
   3. "Needs human decision"
   4. a per-stage summary of 1 or 2 templated lines each
   5. stage details
   6. footer

   Keep the prose minimal and templated so it doesn't get padded (failure matrix: Emit).
3. **`run_report.md` (`src/pipeline/report.ts`).** Written next to the plan. It contains:
   - inputs and resolved versions
   - pack and prompt versions
   - coverage (usages found, covered, out of scope with reasons, uncovered)
   - unparsed and skipped files
   - docs status (fresh, stale or unverified counts, and fallback events)
   - gate results per round
   - what was dropped and why (dedupe merges, lens gaps, budget cuts)
   - the per-step cost (tokens if reported) and time
   - a "target repo untouched" line with the before and after hashes

   Everything is generated from the event spine. Nothing is held only in memory.
4. **Budget (`src/pipeline/budget.ts`).** Time and token budget per run (`--budget-tokens`, `--budget-seconds`). When the budget is exceeded, the remaining lenses are recorded as `budget_cut` and shown in the report. Nothing is silently skipped.
5. **`record_feedback` tool (`src/tools/recordFeedback.ts`).**
   - Input: `run_id`, `finding_id?`, `kind` (`wrong`, `missing`, `severity_wrong` or `other`), `note`, and optional `file` and `line` for `missing`.
   - Stores to `feedback` (migration `006_feedback.sql`) with the run.
   - Exports to `eval/feedback/<run_id>-<n>.json` under the output dir, in a format `eval/runner.ts` can turn into a seeded case or a golden-case annotation. `scripts/feedback-to-case.ts` is manual and reviewed.
   - No training and no network.
   - For `missing`, the file and line go through `SafePath` (the user cannot point outside the repo).
6. **L1 output (`src/pipeline/l1.ts`).**
   - With `--level 1`: per stage it writes `<out>/<run_id>/stages/<n>/CHECKLIST.md` (from the stage's findings: action, verify and rollback) and `<out>/<run_id>/stages/<n>/test-stubs/*.test.ts` (skeletons naming the routes and handlers to test, with `it.todo`).
   - Every write calls `assertLevel(1)` and then `safeWrite`. Nothing is written to the target repo, and stubs are never executed.
   - Without the flag, the `emit_plan` option `l1: true` returns a `PermissionError`: "L1 output requires starting the server with --level 1". An MCP tool argument **cannot** raise the level. Only the process flag can.

## Files and modules

`src/pipeline/{routing,report,budget,l1}.ts`, `src/pipeline/emit.ts` (updated), `src/tools/{recordFeedback,emitPlan}.ts`, `src/store/feedback.ts`, `src/store/migrations/006_feedback.sql`, `scripts/feedback-to-case.ts`, `eval/threshold.md`, `test/unit/{routing,report,budget,feedback}.test.ts`, `test/permissions/{l1-without-flag,l1-writes-only-out,level-from-tool-arg}.test.ts`.

## Tests

- **Routing:** a table test across confidence 0.59, 0.6 and 0.61; each severity; and each source. An agent-judgment blocker at confidence 0.95 still goes to "Review first". A custom threshold is respected and recorded.
- **Emit order:** a golden-file test of section order for a mixed plan, and the needs-human section is present only when it is non-empty.
- **Report:** every number in `run_report.md` traces to events (a test rebuilds the report from a fixture event log).
- **Budget:** exceeding the budget gives a `budget_cut` entry in the report, and nothing is missing silently.
- **Feedback:** stored with the run, exported to the output dir, and a `missing` entry with `../` is rejected.
- **Permissions (the milestone's "done when"):**
  - `l1-without-flag`: an L1 request at level 0 gives a `PermissionError`, and no files are written.
  - `level-from-tool-arg`: passing `level: 1` in a tool argument does not elevate.
  - `l1-writes-only-out`: with `--level 1`, every written file is under `<out>/<run_id>/`, and the repo hash is unchanged.
  - `level-2-refused` (from M1) still passes.

## Acceptance criteria

- On a golden case, `MIGRATION_PLAN.md` shows "Review first" and "Needs human decision" populated according to the rules, and `run_report.md` is complete.
- L1 is refused without `--level 1`. With the flag, checklists and test stubs appear only in the output dir.
- `record_feedback` creates a stored entry and an exportable eval-case file.
- The eval rerun (required, since routing affects the plan) is published in `eval/results.md`.

## Risks

- **Threshold misuse**, where a low threshold hides uncertain findings in the main plan. Mitigation: evidence-based tuning only, and the threshold is printed in the plan footer.
- **"Review first" bloat** if the agent overuses `agent_judgment` high findings. Mitigation: report the count, and M7 tracks the false-alarm rate.
- **L1 test stubs mistaken for real tests.** Mitigation: `it.todo` only, a header comment that says "generated, not run", and they are written outside the repo.

## Dependencies

- M6 (plans, gates, emit), M7 (calibration data, eval rerun), M1 (level and `safeWrite`).

## Must not break

All gates, the eval smoke, the permissions suite (including L2 refusal) and the repo hash.
