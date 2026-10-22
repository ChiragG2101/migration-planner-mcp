# Confidence threshold

The analysis behind `--confidence-threshold` (M9 task 1). PRD section 7 says the threshold is tuned on eval data, "not by feel". This file records what the data supports.

## Decision

**The default stays at 0.6.** There is no evidence yet to move it in either direction.

## What the data holds (2026-10-22)

- **`eval/calibration.csv` has no rows.** It holds only the header `case,finding_id,confidence,correct`. M7 task 9 planned to export confidence-vs-correctness pairs to it, but the runner does not write the file yet.
- **The recorded runs can't calibrate a threshold either.** The 21 engine runs under `eval/runs/<case>/v1/` hold 2,337 findings. Every one has one of two confidence values, set as constants by the programmatic Cursor driver (D41): 0.85 for the 2,292 `rule_pack` findings and 0.6 for the 45 `usage_scan` findings. No finding has `source: agent_judgment`. These confidences were written by a script, not judged by an agent, so pairing them with correctness would only measure the driver's constants.

Moving the threshold on this data would be tuning by feel, so it does not move.

## How to tune it once the data exists

1. Record live engine runs where the host agent sets each finding's confidence itself, under the current prompt version (D17's run rules).
2. Export the pairs to `eval/calibration.csv`: one row per finding, `correct` = 1 when the finding covers a true changed usage in `truth.json`, else 0.
3. For each candidate threshold *t* in 0.05 steps, compute two figures:
   - the precision of findings at or above *t*: these stay in the main plan;
   - the share of correct findings below *t*: these would go to "Needs human decision" without needing to.
4. Pick the lowest *t* where precision at or above *t* is at least the precision of the whole set and the routed share stays small. Report every candidate's figures here. Change `DEFAULT_CONFIDENCE_THRESHOLD` in `src/pipeline/routing.ts` in the same change, and regenerate `eval/results.md` (INV-25).
5. With fewer than 100 rows, or with confidences that take only a few distinct values, keep the default and say so here.

## Risks this guards against

- **Threshold misuse.** A low threshold would hide uncertain findings in the main plan. That is why the default changes only with this evidence. The threshold in use and its source (default or flag) are printed in the plan footer and recorded per run in the `routing.result` event.
