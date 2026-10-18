---
name: review-milestone
description: Use when reviewing a finished milestone or a pull request against its plan in docs/plans/. It is the independent reviewer gate, and checks the diff against acceptance criteria, constraints and scope.
---

# Review a milestone (independent reviewer)

You are the independent reviewer from the per-milestone gates in `docs/plans/00-overview.md`. You judge the diff against the written plan, not against the builder's intentions.

## 0. Independence check

You must not have written this code or seen the builder's reasoning.

- If this session built the code, stop. Tell the user to start a fresh session and run this skill there.
- Use only these inputs: the milestone plan file, `docs/plans/00-overview.md`, `AGENTS.md`, and the diff (`git diff <base>...HEAD` or the PR). Ask the user for the base if it is unclear.
- Ignore PR descriptions and commit messages that argue for the change. Read what the code does.

## 1. Acceptance criteria, line by line

For each acceptance criterion in the milestone file, record one of:

- **Met**, with the evidence: the test name, the file and line, or the command output you ran.
- **Not met**, with what is missing.
- **Cannot verify**, with why.

Run the tests yourself where you can. "The tests probably pass" is not evidence.

## 2. Constraints C1 to C10

Check the diff for each one. The common failures:

- A write API or `child_process` import outside `src/security/` (C3). Search for `writeFile`, `mkdir`, `rm`, `rename`, `spawn`, `exec` and `child_process`.
- A path used without `resolveInside`/`SafePath`, or the deny list bypassed (C4).
- A tool argument or pack field that can reach `exec.ts` or raise the level (C5, C9).
- A network call outside `src/docs/context7.ts`, or repo content in an outbound payload (C6).
- An LLM SDK or MCP sampling dependency (C7).
- Data stored outside `src/store/` (C2), or records missing `repo_id` (C10).
- stdout used for logs in the MCP adapter.

## 3. Gates and tests are real

- Every new gate or permissions rule has a test that **fails** when the guard is removed. Pick at least one guard, remove it locally, and confirm a test fails (the mutation check).
- No test was skipped, deleted or weakened to make the suite pass (the same idea as gate 7).
- No silent truncation or dropped items. Counts and "skipped because" lists are reported.

## 4. Scope

- List every file changed outside the milestone's **Files and modules**. Each needs a reason that comes from the plan.
- Flag features not in **Scope**, even good ones. They belong in a separate change.
- Check **Must not break**: earlier outputs, the recall ratchet, pack lint, prompt immutability, the repo hash.

## 5. Docs and regression rule

- `docs/invariants.md`, `docs/failure-modes.md` and `docs/design.md` reflect what the milestone added.
- If anything under the regression-rule paths in `AGENTS.md` changed (`prompts/`, `knowledge/`, `packs/`, `src/rules/`, `src/analysis/`, staging, packets, routing, gates or `src/verify/`), `eval/results.md` was regenerated in the same change (from M7 on).
- Generated files under `packs/` were regenerated, not hand-edited.
- New or changed rules under `knowledge/` were reviewed by someone other than their author, and the pack update report is attached with every "missing" item explained.

## 6. Verdict

Write the review as:

1. **Verdict:** approve, approve with follow-ups, or changes required.
2. **Acceptance criteria table** from step 1.
3. **Blocking issues:** constraint breaks, unmet criteria, missing tests. Each has a file:line and a concrete fix.
4. **Non-blocking issues:** style, naming, small simplifications.
5. **Out-of-scope changes** found.

Be specific and short. Never approve with a blocking issue open.
