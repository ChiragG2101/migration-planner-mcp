# M8 - Sandboxed verify loop (L1), codemod registry, gate 7 (test integrity)

**PRD refs:** sections 3 (autonomy ladder), 6.7 (verify loop), 7 (gate 7, audit trail), 7A (execution in L1), 8 (Verify loop and Permissions rows), 10 (outcome metrics), 11. **Done when:** every execution permissions test passes, and every weakened-test fixture is rejected by gate 7.

## Scope

- In scope, all behind `--level 1`:
  - `src/security/exec.ts`, the single spawn point, replacing the M1 stub
  - check commands declared by the user (CLI flags in this milestone; the AGENTS.md snippet is added as a second source in M10)
  - the clone sandbox under `<out>/<run_id>/sandbox`
  - a baseline check run before any change
  - the codemod registry (allowlist ID to pinned tool), replacing the ID-only list from M3
  - the stage loop: codemods, agent patch, checks, gate 7, keep or roll back, retry cap
  - gate 7 (test integrity)
  - per-stage patches and `verify_report.json`
  - the tools `verify_stage`, `submit_stage_patch`, `get_verify_report` and the CLI commands `verify` and `report`
  - outcome metrics in the eval runner
  - container mode (`--sandbox container`), which is the first thing cut if behind
- Out of scope: writing to the user's repo (L2), multi-repo runs, running anything at L0, and any command that does not come from user config or the codemod registry.

**What the engine can and cannot guarantee.** The engine guarantees that *it* never writes to the user's repo and only runs what the user declared. It cannot stop the host agent from using its own file or shell tools on the real repo. The skill and prompt tell the agent to submit changes through `submit_stage_patch` only, and the README says this plainly. This is a residual risk recorded in `docs/failure-modes.md`, not a guarantee.

## Tasks

1. **Check config (`src/verify/checks.ts`).**
   - Sources in M8: repeated CLI flags given at process start, `--install "<cmd>"` and `--check <name>="<cmd>"` (for example `typecheck="npx tsc --noEmit"`, `test="npm test"`). For the MCP adapter, these go in the user's MCP config, which the user owns. M10 adds the AGENTS.md snippet `checks:` block as a second source.
   - Commands are parsed into argv with shell-word rules and run **without a shell**. A user who wants a shell writes `sh -c "..."` themselves, which is their explicit choice.
   - The check set is frozen at startup and recorded in the run. No tool argument, pack or knowledge field, prompt or agent message can add, change or reorder checks.
2. **Exec (`src/security/exec.ts`).** `run({ argv, cwd: SandboxPath, timeoutMs })`:
   - Asserts level 1 or above.
   - `cwd` must be a branded `SandboxPath` (a `SafePath` under `<out>/<run_id>/sandbox`). Nothing else type-checks.
   - `argv` must exactly match one of: a configured install or check command, a codemod registry entry (task 5), or one of a fixed set of git operations (`clone`, `apply`, `add`, `commit`, `reset`, `diff`, `status`). The git operations always run with `-c core.hooksPath=/dev/null`, so no repo hook ever runs.
   - The environment is built from an allowlist (`PATH`, `LANG`, `TERM`, `CI=1`, a `HOME` set to a temp dir inside the sandbox), plus any names the user passes with `--pass-env NAME`. Tokens and keys in the parent environment are not inherited.
   - Timeouts per command (default per check, overridable per check). On timeout, the whole process group is killed.
   - stdout and stderr are captured with a size cap. The full size and a hash are recorded, and the tail is kept for the agent.
   - Every call writes `exec.start` and `exec.end` events with argv, cwd, exit code, duration and output hash.
3. **Sandbox (`src/verify/sandbox.ts`).**
   - Created with `git clone --no-hardlinks <repo> <out>/<run_id>/sandbox`. Cloning reads the source repo and writes only to the destination.
   - **The sandbox reflects HEAD, not uncommitted changes.** Before cloning, the dirty check runs `git --no-optional-locks status --porcelain` with `--git-dir` and `--work-tree` pointing at the source and `cwd` in the out dir (`--no-optional-locks` stops git refreshing the index, so the source `.git` is not written). If the tree is dirty, L1 refuses with "commit or stash first: L1 verifies HEAD".
   - The sandbox gets a fixed git identity for its own commits. Old sandboxes are pruned to the last N runs.
4. **Baseline run.** Before any stage, run the install command(s) and every check on the unmodified sandbox. Record pass or fail per check, and per-test results when the user's runner writes a JUnit XML report to a path they declare (`--junit <check>=<path>`). Checks that fail at baseline are marked `baseline_failing`, and later stages are judged on **new** failures only. A run where every check fails at baseline stops with a clear message instead of verifying anything.
5. **Codemod registry (`src/verify/codemods.ts`).** The only place where a codemod ID becomes a command.
   - Each entry: `id`, `runner` (`npx` or `uvx`), `package`, a pinned exact `version`, an argv template whose only placeholders are sandbox paths, and `languages`.
   - Seed entries: the non-interactive `@next/codemod` transforms the Next.js pack references, React's official codemods where they apply, and `django-upgrade` for M10.
   - If the runner is not installed, the codemod step is marked `codemod_unavailable`, and its findings stay as manual steps. It never falls back to another tool.
   - Fetching the pinned package needs network access. This is recorded as an event and stated in the verify report.
   - Adding or re-pinning an entry is a core change: it is reviewed as code and reruns the eval (regression rule, M7).
6. **Stage loop (`src/verify/loop.ts`).** Stages are verified strictly in plan order.
   - `verify_stage({ run_id, stage_id })`:
     1. The plan must have been validated on its latest round, and the stage must not be unresolved.
     2. Every earlier stage must be kept or explicitly skipped. Stages after a skipped one are marked `built_on_skip`.
     3. It tags the stage start in the sandbox, runs the stage's codemods, and returns the codemod diff, the remaining manual findings and the attempt number.
   - `submit_stage_patch({ run_id, stage_id, patch })`: `patch` is a unified diff, or a list of `{ path, content }`.
     - Every path is resolved with `resolveInside(sandboxRoot, p)` and checked against the deny list. The patch is applied with `git apply --check`, then `git apply`.
     - Then the checks run, then gate 7.
     - **Kept:** all checks pass with no new failures, and gate 7 passes. The stage is committed in the sandbox and exported as `<out>/<run_id>/patches/NN-<stage-id>.patch` (the diff from stage start to the commit).
     - **Rejected:** the sandbox is reset to the stage start, and the agent gets the exact failures (check name, exit code, output tail, failing test names when JUnit is available, gate 7 reasons).
     - **Retry cap = 3 attempts per stage.** After that, the stage goes to `unresolved` with every attempt's reasons, and the sandbox is left at the stage start.
   - A check that fails, then passes on an immediate single rerun, is marked `flaky` in the report. It never counts silently as a pass.
7. **Gate 7: test integrity (`src/verify/testIntegrity.ts`).** It uses the shared M6 `Gate` interface and compares the stage start with the candidate tree. Test files are identified with the M1 test setup and globs, and counts come from the M2 language adapters (syntax trees, not regex). The candidate fails on any of:
   - a deleted or renamed-away test file
   - fewer test cases (TS/JS: `it`, `test` and `describe`-level counts; Python: `test_*` functions and `TestCase` methods)
   - fewer assertions (`expect(...)`, `assert`, `self.assert*`)
   - new skip, focus or todo markers (`.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `@pytest.mark.skip`, `skipif`, `xfail`, `unittest.skip`)
   - a deleted snapshot file, or snapshot content rewritten without a matching test change
   - lowered coverage thresholds (Jest and Vitest `coverageThreshold`, `--cov-fail-under`, `fail_under` in coverage config)
   - a change to the files that define the declared checks (for example the `test` script in `package.json`, or `pytest.ini` options that deselect tests)

   Some reductions are legitimate, for example removing tests for an API the upgrade deletes. Those are never kept automatically: the patch goes to `<out>/<run_id>/patches/needs-review/` and the stage is listed under "Review first" with the gate 7 reason, for the human to decide.
8. **Container mode (`src/verify/container.ts`, cut first if behind).**
   - `--sandbox container` with `--sandbox-image <image>` given by the user. Docker or Podman is detected; if neither exists, the flag is refused.
   - Only the sandbox dir is mounted. The install step may use the network. Checks run with the network off.
   - If this is cut, the flag is refused with "not built in v0.1".
9. **Store (`src/store/verify.ts`, migration `005b_verify.sql`).** `sandboxes(run_id, path, source_head, created_at)`, `baseline_checks(run_id, check, status, junit_json)`, `stage_attempts(run_id, stage_id, attempt, codemods_json, patch_hash, checks_json, gate7_json, decision)`.
10. **Verify report (`src/verify/report.ts`, tool `get_verify_report`, CLI `report`).** `verify_report.json` lists, per stage: the decision, attempts, codemods run, checks with durations, gate 7 results, the patch path, and the network-using steps. M9 renders it into `run_report.md`. Applying patches is left to the user (`git apply <out>/<run_id>/patches/*.patch`). The report prints that exact command and never runs it.
11. **Eval integration.** The runner (M7) gains outcome metrics: first-pass verify rate, mean attempts per stage, the share of stages unresolved, gate 7 incidents, flaky checks, and verify wall time.
    - Live mode runs L1 on golden cases whose `case.json` declares `checks`.
    - Replay mode re-scores the recorded `stage_attempts`.
    - **Patch replay check:** applying all kept patches to a fresh clone of the base commit must reproduce the sandbox's final tree hash.
12. **CI fixtures.** Two tiny repos the project owns, so CI can run L1 for free:
    - `test/fixtures/l1-node/`: a few Vitest tests and a `tsc` check
    - `test/fixtures/l1-python/`: a few pytest tests

    Running these in CI is safe, because they are our own code.

## Files and modules

`src/security/exec.ts`, `src/verify/{checks,sandbox,codemods,loop,testIntegrity,container,report}.ts`, `src/core/{verifyStage,submitStagePatch,getVerifyReport}.ts`, `src/tools/{verifyStage,submitStagePatch,getVerifyReport}.ts`, `src/cli/{verify,report}.ts`, `src/schema/verify.ts`, `src/store/verify.ts`, `src/store/migrations/005b_verify.sql`, `eval/metrics.ts` (outcome group), `test/fixtures/{l1-node,l1-python}/`, `test/fixtures/g7/` (one fixture pair per gate 7 rule), `test/unit/verify/*.test.ts`, `test/permissions/{exec-*,sandbox-*}.test.ts`.

## Tests

- **Permissions (the milestone's "done when"):**
  - `exec-at-l0-refused`: every exec path throws at level 0, and no process is spawned (a spawn spy).
  - `exec-cwd-outside-sandbox-refused`: a `cwd` of the source repo, the out dir root or `/tmp` does not type-check, and a forced cast is caught at runtime.
  - `command-from-tool-arg-refused`: tool input schemas reject any `command`, `argv` or `script` field, and a static test asserts that no tool schema has a free-text field that reaches `exec.ts`.
  - `unlisted-argv-refused`: an argv that is not a configured check, a registry codemod or an allowed git operation is refused, and so is a configured check with an extra argument appended.
  - `unlisted-codemod-refused`: a knowledge rule or finding naming an unknown codemod ID is refused.
  - `env-scrubbed`: with `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` set in the parent, a fixture check that prints its environment shows neither.
  - `source-repo-untouched`: the source repo hash, including `.git/index`, is identical after a full L1 run (clone, dirty check, three stages, a rollback).
  - `source-hooks-not-run`: a `post-checkout` hook planted in the fixture's `.git/hooks` does not run during clone or any sandbox git operation.
  - `patch-escape-refused`: patch paths with `../`, absolute paths, a deny-listed file or a symlink pointing outside the sandbox are refused, and nothing is written.
  - `dirty-tree-refused`: L1 on a dirty fixture refuses with the "verifies HEAD" message.
  - `level-2-refused` (from M1) still passes.
- **Gate 7:** each fixture pair in `test/fixtures/g7/` must fail with its exact reason: a deleted assertion, an added `.skip`, an added `@pytest.mark.skip`, a deleted snapshot, a lowered coverage threshold, a deleted test file, a changed `test` script. A source-only change passes. A test update that adds assertions passes. Mutation check: disabling any single rule makes its fixture pass, which the test detects.
- **Loop:**
  - after three failed attempts the stage is `unresolved` and the sandbox tree hash equals the stage start
  - a rollback restores the exact tree hash
  - out-of-order `verify_stage` is refused
  - a `baseline_failing` check does not fail a stage
  - a timeout fails the attempt with the reason
  - a flaky check is reported as `flaky`
- **Codemods:** registry entries are pinned to exact versions (no ranges, no `latest`); a missing runner gives `codemod_unavailable`; a codemod run is recorded with its version.
- **Patch replay:** on both CI fixtures, applying the exported patches to a fresh clone reproduces the final sandbox tree.
- **Regression:** with no `--level 1`, every earlier test and the eval smoke are unchanged.

## Acceptance criteria

- On at least 2 Next.js golden cases with runnable tests, a full L1 run produces kept patches whose checks pass, a `verify_report.json`, and outcome metrics in `eval/results.md`. The source repo hash is unchanged.
- Applying all kept patches to a fresh clone of the base commit reproduces the sandbox's final tree.
- Every gate 7 fixture is rejected with its reason, and needs-review patches never land in `patches/` itself.
- The full permissions suite, including every new exec and sandbox test, passes. Removing any single exec guard makes at least one test fail. Verify this once, by hand, as a mutation check.

## Risks

- **The host agent edits the real repo with its own tools.** Mitigation: the skill and prompt direct all changes through `submit_stage_patch`, the demo shows the repo is untouched, and the README states that the engine can only guarantee its own behaviour.
- **Sandbox escape or misuse.** Mitigation: a single spawn point, argv allowlist, no shell, cwd pinned, a scrubbed environment, no hooks, and container mode for stronger isolation. The clone sandbox is not a security boundary against hostile code; the checks are the user's own code that they already run. Say so in the README.
- **Flaky or slow test suites.** Mitigation: the baseline run, a single rerun marked `flaky`, per-check timeouts, and the run budget from M9.
- **Checks need services** (a database for Django tests, browsers for end-to-end tests). Mitigation: the user declares them; container mode lets them supply an image; anything missing shows up as a baseline failure rather than a stage failure.
- **Codemods that are interactive or change behaviour between versions.** Mitigation: only non-interactive transforms are registered, versions are pinned exactly, and a re-pin reruns the eval.
- **Repo content that tries to instruct the agent to run commands** (prompt injection through comments or docs). Mitigation: the engine never runs a command the agent supplies, so injected instructions can at most produce a bad patch, which the checks and gate 7 then judge.

## Dependencies

- M6 (validated, staged plans and the shared gate interface), M7 (the eval runner and golden cases), M1 (security layer and level), M2 (language adapters for counting tests), M3 (codemod IDs in the knowledge, and the ID list in `src/verify/codemodIds.ts`).

## Must not break

L0 behaviour with no flag (every earlier test and the eval smoke), all gates, the permissions suite, prompt immutability and the repo hash.
