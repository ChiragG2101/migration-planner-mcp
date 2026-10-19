---
name: implement-milestone
description: Use when building a milestone (M1 to M10) of this repo, or any task in docs/plans/. It keeps the work inside the plan's scope and runs the milestone gates before calling it done.
---

# Implement a milestone

The plan is the contract. Build what it says, nothing more, and prove it with its own acceptance criteria.

## 1. Load the context (read, don't skim)

1. `AGENTS.md`: constraints C1 to C10 and the architecture rules.
2. `docs/plans/00-overview.md`: the constraints table, the per-milestone gates, and the target layout.
3. The milestone file, `docs/plans/NN-*.md`, all of it: Scope, Tasks, Files, Tests, Acceptance, Risks, Dependencies, Must not break.
4. The plans for every milestone listed under **Dependencies**, so you know the interfaces you build on.
5. `docs/design.md`, `docs/invariants.md` and `docs/failure-modes.md` if they exist.

If a dependency milestone is not done, stop and tell the user. Do not build on top of missing pieces.

If the milestone file has an `## Open items` section (left there by a capped plan review), settle each item with the user before writing code. Record each decision in `docs/design.md`, update the plan, and remove the item.

## 2. Write a short plan first

Before writing code, write out:

- The tasks you will do, in order, each mapped to a task number in the milestone file.
- The files you will create or change. Flag any file outside the milestone's **Files and modules** list, and say why.
- How each acceptance criterion will be shown to pass.
- Anything ambiguous in the plan. **Ask the user** rather than guessing. Small gaps can be decided in the open, recorded as a decision in `docs/design.md`.

Get the user's go-ahead on the plan for anything larger than a single task.

## 3. Build in this order

1. **Permissions and invariant tests first.** For every rule the milestone touches (path boundary, read-only, no exec at L0, deny list, and so on), write the failing test in `test/permissions/` or `test/unit/` before the code. Use the `write-tests` skill.
2. **Schemas and interfaces next** (`src/schema/`, adapter interfaces). Other code depends on them.
3. **Core logic** in `src/core/`, `src/pipeline/`, `src/analysis/`, `src/lang/`, `src/verify/`.
4. **Adapters last** (`src/cli/`, `src/tools/`, `src/server.ts`). They stay thin: validate input, call core, return the result. No logic in adapters.

Keep each commit to one coherent step, and keep the test suite passing between steps.

## 4. Hard rules while building

- Never weaken a constraint to make something work. If C1 to C10 or a gate gets in the way, stop and raise it. A constraint change is a design decision for the user, not an implementation detail.
- No scope creep. Useful extras go in a list for the user ("noticed, not done"), not in the diff.
- Only `src/security/` writes files or spawns processes. Only `src/docs/context7.ts` uses the network.
- Knowledge and packs are data. Never add an executable field, a command string or a script to either.
- Prompts are versioned. Never edit a released `prompts/*.vN.md`; add `vN+1`.
- Generated files (SKILL.md and references under `packs/`) are never edited by hand. Change the knowledge or `pack.json` and regenerate.
- `src/` never imports from `scripts/` or `eval/`. Maintainer tools that use the network, and eval tooling that writes files and runs git, stay outside the engine.
- If you change anything under the regression-rule paths in `AGENTS.md` (`prompts/`, `knowledge/`, `packs/`, `src/rules/`, `src/analysis/`, staging, packets, routing, gates or `src/verify/`), regenerate `eval/results.md` in the same change. Before M7 there is no eval yet; say so in the handover.

## 5. Run the gates

All of these must hold before you say the milestone is done (overview, "Per-milestone gates"):

1. The test suite passes, including `test/permissions/`, which is never skipped.
2. The typecheck and the lint pass.
3. The eval smoke set passes.
4. The target-repo hash is unchanged after the milestone's demo command.
5. The spine docs are updated: run the `update-spine-docs` skill, and `scripts/check-spine.sh` passes.

Use the commands in `AGENTS.md` ("Planned tooling"). If a command does not exist yet, say so plainly. Never report a gate as passed without running it.

## 6. Hand over

Tell the user:

- What was built, task by task, and the acceptance criteria with evidence (test names, command output).
- Anything not done, deferred or decided along the way.
- The two remaining gates, which are theirs to run:
  - an **independent review**: a fresh session runs `review-milestone`;
  - a **comprehension check**: the user runs `quiz-me`.

Do not run the review yourself in the same session. The reviewer must not see your reasoning.
