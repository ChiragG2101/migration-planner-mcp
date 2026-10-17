# M6 - merge_findings and the validate_plan gates

**PRD refs:** sections 6.4, 6.5, 6.6 (emit, minimal), 7 (the 6 hard gates), 8 (Aggregator and Gates rows). **Done when:** bad plans are rejected for each gate type.

## Scope

- In scope:
  - the deterministic aggregator (dedupe, conflict resolution, staging, coverage flags)
  - the deterministic critic `validate_plan`, with the 6 gates as separate, individually tested modules
  - the round loop (at most 3), with unresolved items kept visible
  - a minimal emit of `MIGRATION_PLAN.md` and `plan.json` to `--out`
- Out of scope: confidence routing and the needs-human section (M9), the full run report (M9), and gate 7 (test integrity), which runs on L1 stage patches in M8.

## Tasks

1. **`merge_findings` (`src/pipeline/aggregate.ts`, core, tool `src/tools/mergeFindings.ts`, CLI `merge`).**
   - **Dedupe key:** `(evidence repo_id, file, line_start, line_end, normalised action)`, where the normalisation lowercases the text, collapses whitespace and strips punctuation. Exact-key duplicates merge, and their `usage_ids` and `doc_refs` are combined.
   - **Conflicts:** when the same key has different severity or concern, take the higher severity, keep both reasonings and write a `conflict` event. Different actions on the same span are **not** merged; both are kept and flagged `overlapping` for review (failure matrix: merging findings that are actually different).
   - **Staging:** group findings into stages using the import graph from M2. The strategy is a generic core option selected by **pack data** (`staging` in the pack: `leaf_first` or `config_first`), so a later pack does not need a core change:
     - Stage 0 is dependency and build prep: for a `swap`, adding the new library alongside the old one; for an `upgrade`, bumping the version and resolving peer-dependency conflicts.
     - `leaf_first` (the Next.js default): leaf modules come before the modules that import them, so the build can stay green. Entrypoints (pages, layouts, route handlers, middleware) come last, and for a `swap`, removing the old dependency comes after that.
     - `config_first`: configuration and settings changes come first, then modules in leaf-first order.
     - **Within a stage, codemod steps come before manual steps**, so manual findings describe what is left after the codemod, and the verify loop (M8) can run the codemod first.
     - Each stage gets `depends_on` derived from the graph.
     - Stage titles are templated, not LLM-written.
   - **Coverage flags:** any usage ID with no covering finding and no `out_of_scope` entry is listed under `uncovered_usages` (input to gate 2).
   - Output: a `Plan` object stored in SQLite with a `round` number.
2. **Gates (`src/pipeline/gates/`), one file per gate with a shared interface `Gate { id, run(plan, ctx) => GateResult[] }`.** `GateResult` is `{finding_id | stage_id | null, gate, pass, reason, expected?, actual?}`, so the agent sees the *exact* failure.
   1. `g1-evidence.ts`: every evidence file resolves through `SafePath` for its `repo_id`, the line range is within the file, and the recomputed `snippet_hash` (the same normaliser as M2) matches.
   2. `g2-coverage.ts`: every `find_usages` usage for the run is covered by `usage_ids` on some finding, or by `out_of_scope` with a non-empty reason.
   3. `g3-doc-refs.ts`: every `doc_refs[].doc_id` exists in `run_docs` for **this** run, and the URL matches the stored URL.
   4. `g4-rollback-verify.ts`: severity `high` or `blocker` requires non-empty `rollback` and `verify` that are not placeholders (a blocklist rejects "TBD", "n/a" and "revert", the last only when it is the whole string).
   5. `g5-stage-order.ts`: for each stage S and each finding in S that touches file F, no file F imports (transitively, via the import graph) may have a required change in a later stage. Dependency stages must come before the stages that use them, and `depends_on` must have no cycles.
   6. `g6-schema-ids.ts`: Zod validates the whole plan, and finding and stage IDs are unique.
   The gate interface is shared with gate 7 (`src/verify/testIntegrity.ts`, M8), so all gates report results in one format.
3. **`validate_plan` (core, tool `src/tools/validatePlan.ts`, CLI `validate`).**
   - Runs all gates and returns per-finding pass or fail plus a summary.
   - Increments the round counter and records `gate.result` events with the findings before and after (audit trail).
   - **Round cap = 3.** After round 3, failing findings move to `plan.unresolved[]` with their gate reasons, and the plan is still emitted. It is **never** marked as passed.
   - Gates check against real files on every round, so an agent that just rewrites text to satisfy a gate still fails gate 1 if the evidence doesn't match (failure matrix: Gates).
4. **Emit, minimal (`src/pipeline/emit.ts`, tool `emit_plan`, CLI `emit`).** Writes `plan.json` and `MIGRATION_PLAN.md` via `safeWrite` to `<out>/<run_id>/`.
   - The Markdown has a stage-by-stage summary, and each finding shows severity, `file:line` links, docs links, action, rollback and verify.
   - An "Unresolved" section sits at the top whenever it is non-empty.
   - A footer states the pack version, the prompt version and that the target repo was not modified.
   - The emit refuses to run if `validate_plan` has not been run on the latest round.

## Files and modules

`src/pipeline/aggregate.ts`, `src/pipeline/gates/{index,g1-evidence,g2-coverage,g3-doc-refs,g4-rollback-verify,g5-stage-order,g6-schema-ids}.ts`, `src/pipeline/emit.ts`, `src/tools/{mergeFindings,validatePlan,emitPlan}.ts`, `src/store/plans.ts`, `src/store/migrations/005_plans.sql`, `templates/MIGRATION_PLAN.md.hbs` (or a template literal), `test/unit/gates/*.test.ts`, `test/fixtures/plans/{good,bad-g1..bad-g6}.json`.

## Tests

- **One "bad plan" fixture per gate, which is the milestone's "done when":**
  - `bad-g1`: a hash mismatch, a non-existent file and a line past the end of the file.
  - `bad-g2`: one usage left uncovered, and an `out_of_scope` entry with an empty reason.
  - `bad-g3`: a URL never retrieved in this run, and a `doc_id` from a different run.
  - `bad-g4`: a high finding without rollback, and a blocker whose verify is "TBD".
  - `bad-g5`: an importer staged before its dependency, and a cycle in `depends_on`.
  - `bad-g6`: a duplicate ID and a missing required field.
  Each fixture fails **only** its target gate, and a test asserts the other gates pass, so the gates are shown to be independent.
- **False-pass checks:** mutating a good plan in each of these ways must flip the gate result. A gate that passes after a mutation is a bug.
- **Aggregator:** exact duplicates merge, a severity conflict takes the higher value and writes a conflict event, different actions on the same span are not merged, staging on a small graph fixture comes out in leaf-first order, `config_first` puts config findings first, and within a stage codemod steps come before manual steps.
- **Round cap:** after 3 failing rounds, the plan is emitted with `unresolved[]` populated and the status is not `passed`.
- **Permissions:** emit writes only under `<out>/<run_id>/`. An emit with `--out` pointing into the repo is refused, and the repo hash is unchanged.

## Acceptance criteria

- Each of the 6 gate types rejects its bad-plan fixture with an exact, machine-readable reason.
- The good-plan fixture passes all gates. On the M5 real-repo run, the flow `merge_findings` → `validate_plan` (up to 3 rounds) → emit produces `MIGRATION_PLAN.md` and `plan.json` outside the repo.
- Unresolved items are always visible at the top of the plan.
- No LLM is involved in any gate (no network, no model dependencies in `src/pipeline/gates/`, enforced by an import lint).

## Risks

- **A gate that passes wrongly is the most dangerous failure.** Mitigation: the mutation tests above, and the independent reviewer checks the gate code against PRD section 7 line by line.
- **Gate 5 depends on import-graph quality.** Dynamic imports are unresolved. Mitigation: findings touching modules with unresolved dynamic imports get a `stage_order_unverified` warning rather than a silent pass.
- **The agent gaming the gates** (for example by marking everything out of scope). Mitigation: the `out_of_scope` count and reasons are reported prominently, and M7 measures recall against real PRs, which catches this.
- **Dedupe being too aggressive or too weak.** Mitigation: the key is deterministic and every merge is logged, with M7 eval feedback.

## Dependencies

- M5 (findings and schemas), M2 (the usages and import graph), M4 (`run_docs`).

## Must not break

The permissions suite, the repo hash, schema compatibility with M5-stored findings, and the earlier smoke checks.
