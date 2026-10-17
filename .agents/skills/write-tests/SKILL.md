---
name: write-tests
description: Use when writing or changing tests in this repo, especially permissions, gate or eval tests. It covers where tests go, how to prove a guard works, and what a test may never do.
---

# Write tests

In this project, tests are the safety controls. A permissions rule without a failing-when-removed test does not exist.

## Where tests go

| Kind | Folder | Purpose |
| --- | --- | --- |
| Permissions | `test/permissions/` | One file per rule from AGENTS.md and 7A of the PRD. Never skipped, part of every milestone gate. |
| Unit | `test/unit/<area>/` | Behaviour of one module: schemas, adapters, gates, routing. |
| Integration | `test/integration/` | An MCP client or the CLI calling the engine end to end on a fixture. |
| Fixtures | `test/fixtures/<name>/` | Small repos owned by this project. |
| Eval | `eval/` | Recall, golden cases and baseline. Not unit tests; see `docs/plans/07-*`. |

## Rules

1. **Test first for every guard.** Write the test that proves the rule (path escape rejected, write outside `--out` refused, exec at L0 refused), watch it fail, then write the guard.
2. **The mutation check.** For each guard, remove or weaken it locally and confirm at least one test fails. If nothing fails, the test is not testing the guard. Record that you did this in the PR or handover.
3. **Assert the exact reason, not only that it failed.** Check the error type (`PermissionError`) and the message or code, so a test cannot pass because of an unrelated error.
4. **Bad-input fixtures, one per rule.** Gates get one fixture that fails only that gate, and a test that the other gates pass on it, so the gates are shown to be independent.
5. **No silent drops.** When code reports counts, skipped files or truncation, a test checks those numbers, including the zero case.
6. **Repo untouched.** Any test that runs tools on a fixture repo compares the repo hash (`scripts/repo-hash.ts`) before and after.
7. **Deterministic.** No real network, no clock or random values without injection, and no dependence on test order. Context7 uses recorded fixtures (`test/fixtures/context7/`).
8. **Fixtures with ignored names** (`.env`, `node_modules/`, `.venv/`) and symlink escapes are built at test time in a temp dir, not committed. `.gitignore` would drop them.
9. **Golden-file tests** only for generated output (packs, reports, emitted plans). Keep golden files small and readable, and regenerate them on purpose, never to make a failure go away.

## Never

- Never skip, `.only`, delete or weaken a test to make a change pass. If a test is wrong, fix it in its own commit with the reason in the message. (This is gate 7's rule applied to our own repo.)
- Never lower a coverage threshold or remove assertions without the user agreeing.
- Never test through the real user home, real repos, or anything outside temp dirs and fixtures.

## Checklist before you finish

- [ ] Each new guard has a test, and the mutation check was done.
- [ ] Error type and reason are asserted.
- [ ] Counts and skip lists are checked, including zero.
- [ ] Repo hash is compared where tools touch a fixture.
- [ ] The suite passes, with no skips added.
