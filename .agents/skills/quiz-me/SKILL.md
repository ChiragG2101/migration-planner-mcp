---
name: quiz-me
description: Use when the user asks to be quizzed on code or on a milestone. It is optional; the per-milestone gate is the reviewer's summary (docs/plans/00-overview.md, gate 6). It tests that the human understands what was built.
---

# Comprehension check

The user asked to check their understanding of what was built. This is optional: the per-milestone gate is the reviewer's summary (overview, "Per-milestone gates", gate 6). Your job is to find the gaps, not to make the user feel good.

## 1. Pick the material

- Ask which milestone or diff to cover if it is not clear. Default: the latest milestone (`git log` plus its plan file).
- Read the plan file and the actual code. Questions come from the code, not only from the plan.

## 2. Write 6 to 8 questions

Mix these kinds, at least one of each:

- **Trace:** "A tool call arrives with path `../x`. Which functions does it pass through, and where is it rejected?"
- **Why:** "Why does `snippet_hash` use one shared normaliser instead of each module hashing on its own?"
- **What breaks:** "If someone replaced `resolveInside` with `path.join`, which test fails, and what would a user notice?"
- **Constraint:** "Where would a new network call be allowed, and what stops it elsewhere?"
- **Change:** "How would you add a new usage kind to the Next.js adapter without a core change?"
- **Debug:** "`find_usages` reports zero usages on a repo that clearly has some. Where do you look first?"

Each question names real files, functions or tests from this milestone. No trivia, and no questions answerable by reading a single line.

## 3. Run it

- Ask **one question at a time** and wait for the answer.
- Do not hint before the user answers.
- After each answer:
  - say whether it is right, partly right or wrong;
  - give the correct answer with file:line references;
  - if it was wrong, ask one short follow-up on the same point.

## 4. Score and next steps

At the end, give:

- The score, and which questions were missed.
- The 2 or 3 concepts to revisit, each with the file to read.
- A pass or not-yet verdict. Not-yet means the user should reread those files; it does not block the next milestone.

Keep the tone direct and friendly. The point is understanding, not a grade.
