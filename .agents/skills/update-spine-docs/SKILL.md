---
name: update-spine-docs
description: Use when a change adds a rule, a failure case or a design decision, or at the end of a milestone. It keeps docs/invariants.md, docs/failure-modes.md and docs/design.md in step with the code.
---

# Update the spine docs

Three files carry what the code can't say on its own. They are part of the milestone gates (overview, gate 7), so a milestone is not done until they match the code.

| File | Holds | Add an entry when |
| --- | --- | --- |
| `docs/invariants.md` | Numbered rules that must always hold, each with the test that proves it | A new guard, gate or constraint check was added |
| `docs/failure-modes.md` | The failure matrix (PRD section 8) with a "test or check" column | A new way things can go wrong was found or handled |
| `docs/design.md` | Decisions taken during the build, with the reason | Any choice the plan left open, or any change from the plan |

## 1. Find what changed

Read the diff for the milestone or PR. List:

- new guards, gates, permission rules and the tests that prove them
- new failure cases handled, or real-repo surprises
- decisions made: a library picked, a default set, a plan task done differently, a deferral

## 2. Invariants

- One line per rule: `INV-<n>: <rule> (<test file>)`. Numbers are never reused, even if a rule is removed (mark it `retired` with the reason).
- Every invariant names a test that fails when the rule breaks. No test, no invariant: write the test first (`write-tests` skill).
- Keep the constraint IDs (C1 to C10) where a rule comes from one.

## 3. Failure modes

- Add or update the row for the component: the engineering failure, the LLM failure, the design response and the test or check.
- When a real repo surprised the engine, add the row **and** a seeded or golden case for it (the quadrant rule in PRD section 8).

## 4. Design decisions

- One entry per decision: the date, the decision, the reason, the alternatives considered, and what would make us revisit it.
- If the decision changes a constraint, a gate, the milestone map or the PRD, update those files too. The PRD stays the source of truth for what is being built.
- Keep entries short. They are a log, not an essay.

## 5. Keep the instructions in sync

- If a new command, script or folder exists, update `AGENTS.md` ("Planned tooling", then real tooling once it exists).
- If a skill's steps became wrong, update the skill in `.agents/skills/` in the same change.

## Not here

Market research, competitor notes and strategy belong in the maintainer's private notes, not in these public docs.
