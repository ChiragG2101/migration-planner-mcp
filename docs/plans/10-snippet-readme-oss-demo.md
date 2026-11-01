# M10 - AGENTS.md snippet, L1 evidence, README, open-source files, plugin, demo, name

**PRD refs:** sections 9 (packs and skills, for the plugin bundle), 10 (eval, for the L1 evidence), 14 (demo, README, snippet, open source). **Done when:** v0.1's one pack (Next.js) has its L1 evidence in `eval/results.md`, and the README states its limits and claims only what exists.

**The Django pack moved to M12 (v0.2) on 2026-11-01 (`docs/design.md` D60).** Tasks 1 to 3 (the Django adapter, knowledge and pack, and eval cases), the "Why Django is pack 2" and "No core changes" sections, and the Django tests and acceptance now live in [`12-django-pack.md`](12-django-pack.md). The remaining tasks keep their numbers, so earlier references to them stay valid.

## Scope

- In scope:
  - the AGENTS.md snippet reader at ingest, including declared checks (done, Core PR B)
  - the "no core changes" allowlist check, built ahead of any pack PR (done, Core PR A); its definition is in M12
  - the L1 eval evidence for Next.js (task 10)
  - the open-source files: `CONTRIBUTING.md`, `AI_POLICY.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates
  - the Claude Code plugin bundle (generated skills plus the MCP config)
  - the final README
  - the 60 to 90 second demo
  - the final name
- Out of scope: the Django pack (M12, v0.2), npm publish and tagging (M11), third-party packs loaded from outside the repo, and other languages.
- Cut order: nothing in M10 is cut. The README, snippet, open-source files, plugin, demo and L1 evidence all ship.

## Delivery order (gap found in the M9 review, 2026-10-24; revised 2026-11-01, D60)

1. **Core PR A:** `scripts/check-core-untouched.ts` with its planted-change tests, wired into CI. Done 2026-10-25 (D57). Its first real pack PR is M12's.
2. **Core PR B:** the AGENTS.md snippet (task 4), with its permissions tests. Done 2026-10-31 (D58).
3. **CI case-fetch-order core PR:** the PR #5 review's open items 1 and 2 (D59). Built 2026-10-31 as PR #6; approved and merged 2026-11-01.
4. **L1 evidence core PR:** task 10, then the live L1 runs (handover).
5. **Docs and release PR:** open-source files, plugin bundle, name, README and demo (tasks 5 to 9). It comes after the L1 runs, because the README and the demo show their results. The name lands last because it renames the snippet heading and the bundle.

## Open items (deferred from the PR #5 review, 2026-10-31)

PR #5 (`npm run cases:fetch` in CI, `docs/design.md` "Case commits") was approved with three items left open. Items 1 (CI step order) and 2 (named error for a malformed `case.json`) were done in the CI case-fetch-order core PR (`docs/design.md` D59). Item 3 stays open, unchanged (D59).

3. **Test for `--` in the maintainer clones.** The `--` before `kase.repo_url` in the `git clone` calls in `scripts/derive-truth.ts` and `scripts/verify-case.ts` has no test of its own. It backs up the tested `Case.parse` check. Add one if those scripts gain a seam for it (they clone over the network, so they have none today).

## Tasks

4. **AGENTS.md snippet (separate core PR).**
   - `examples/AGENTS.snippet.md`: a short fenced block under a `## migration-planner` heading (renamed with the final name) with these keys:
     - `checks`: `install` plus named checks
     - `planner_deny`: a list of globs
     - `targets`: for example `next@16` or `django@5.2`
   - Reader (`src/pipeline/agentsSnippet.ts`, called from ingest). It reads `AGENTS.md` at the repo root via `SafePath`, if present, and parses only the fenced block under that heading.
     - `planner_deny` globs are **added** to the deny list. A glob that tries to un-deny (for example `!.env`) or point outside the root, including a Windows drive path, a UNC share or `..` on backslashes, is rejected and logged. So is a glob that is too long, has too many `**`, or is past the per-snippet cap (D58). A rejected glob takes none of the cap's slots, so it cannot crowd out the valid globs after it.
     - `checks` become a second source for M8's check config. The repo's own file may have been written by someone else, so checks from the snippet are printed at startup and are used only with `--trust-repo-checks`. CLI flags always win. The first adopted set stays frozen for that engine.
     - `targets` is checked against the user's request. A mismatch produces an ambiguity question, not a silent override. `confirm_target: true` (CLI `--confirm-target`) plans the requested target and records it. The snippet never rewrites the request.
   - The engine works without it, and its absence is logged as "AGENTS.md snippet: not found".
   - This touches `src/pipeline/ingest.ts`, `src/security/denyList.ts` and `src/verify/checks.ts`. Because it is a core change, it lands in its own PR, separate from the Django pack PR, so the "no core changes" check stays meaningful for the pack.
5. **Open-source files.** `CONTRIBUTING.md` and `AI_POLICY.md` were added before M10; M10 brings them up to date with the points below. The rest are new.
   - `CONTRIBUTING.md`: packs are the unit of contribution. A pack PR must include the knowledge it needs (one release per PR, each reviewed by someone other than its author), its `pack.json`, the generated skill, at least 2 golden cases, a seeded repo, the pack update report and an eval run that beats the baseline on recall (`docs/design.md` D17). CI's eval and the pack lint are part of review. Core changes need an issue first.
   - `AI_POLICY.md`: AI-assisted contributions are welcome when disclosed in the PR. The human contributor is responsible for every change, must be able to explain it, and signs off every commit (DCO). AI co-author trailers are optional and are there for transparency; they never make the AI the accountable author.
   - `SECURITY.md`: how to report a sandbox, path-boundary or exec issue privately.
   - `CODE_OF_CONDUCT.md` and issue templates (bug, pack request with demand evidence, golden-case submission).
   - `CONTRIBUTING.md` also says that the "no core changes" check has not yet judged a real pack PR (the first is Django, M12), so a new pack may surface a core change, which goes in its own core PR first.
6. **Plugin bundle (`plugin/`).** A Claude Code plugin that installs the generated skill for every pack under `packs/` (the Next.js pack in v0.1) and the MCP server config, plus a Cursor config snippet. It is generated from the packs (no hand-written copies), and the pack lint covers it.
7. **Name.** Choose the final name. Criteria:
   - it says "migration" or "upgrade", not "MCP"
   - it is free on npm and GitHub
   - it is short enough to type as a CLI command

   Record the decision in `docs/design.md`, and update the binary name, the snippet heading, the plugin and the docs. The repo rename happens in M11.
8. **README (final):**
   1. pitch
   2. demo GIF
   3. one-snippet install (CLI, Claude Code plugin, Cursor)
   4. example output (an excerpt from a real `MIGRATION_PLAN.md` and a verify report)
   5. how it works (the PRD section 6 diagrams)
   6. eval table per pack with the baseline comparison and the L1 outcomes, copied from `eval/results.md` with the misses linked
   7. **Limits:**
      - one pack, Next.js, so TS/JS repos only (the Python adapter ships, the Django pack is v0.2)
      - single repo
      - never writes to your repo
      - L1 runs your declared checks in a sandbox copy; the clone sandbox is not a security boundary
      - the engine cannot stop your agent's own tools from editing your repo
      - no third-party packs
   8. how to add a pack (link to `CONTRIBUTING.md`)
   9. companions (GitHub MCP, filesystem MCP, git MCP), with links checked against current docs

   The status stays "currently building" until v0.1 ships in M11 with real eval numbers (C8).
9. **Demo (60 to 90 seconds; `docs/demo/script.md` plus a recorded GIF or MP4).** Show Claude Code on a real Next.js repo on an older major:
   1. `git status` is clean
   2. ask for a plan
   3. show `validate_plan` rejecting a draft for an uncited claim (gate 3) or an evidence mismatch (gate 1)
   4. show the passing plan with file:line links and the "Needs human decision" section
   5. run one stage at L1 and show gate 7 rejecting a patch that skipped a failing test, then the corrected patch being kept
   6. `git status` is still clean, and the repo hash matches

   Script it so it can be reproduced.
10. **L1 eval evidence for Next.js (core PR; gap found on 2026-11-01, D60).** M8's first acceptance criterion asks for a full L1 run on at least 2 Next.js golden cases with runnable tests, "and outcome metrics in `eval/results.md`". M8 task 11 describes L1 runs recorded under `eval/runs/<case>/<prompt_version>/l1/<n>/` and a replay mode that re-scores their `stage_attempts`. The eval side has only the folder rule and the metric: `eval/addOnly.ts` keeps L1 sets add-only, `eval/load.ts` skips them, and `outcomeMetrics` in `eval/metrics.ts` has nothing to feed it. There is no L1 run record, export, replay or `results.md` section. M10 had relied on a Django L1 run for this, and that moved to M12. This task builds the missing half, so the README's verify claim rests on recorded evidence. What replay re-checks is settled (D61); the record's fields are not:
   - **Record (propose first).** Before coding, the builder proposes the L1 run record's field list, gets the maintainer's agreement and records it in `docs/design.md`. It holds at least, per stage, each attempt's patch, check results, gate 7 result and decision; the verify wall time; the sandbox's final tree hash from the live patch-replay check; and the source repo hash before and after the run. The same entry says how replay builds each stage's start and candidate trees from the pinned checkout and the recorded patches without running a command: in memory, which needs a gate 7 change because `snapshotTests(dir)` reads trees from disk, or written as files under `eval/.work/` (gitignored). The record lives in `eval/schema.ts`, and `npm run runs:export` exports it from a run's store (D41).
   - **Load and replay.** `eval/load.ts` loads L1 sets instead of skipping them. `eval/replay.ts` re-scores them with no model, no network and no command run (INV-77). It re-runs HEAD's gate 7 statically on each recorded patch against the pinned case checkout, so a gate 7 change shows in `results.md` (D61). The patch-replay tree-hash check needs git to apply patches, so it stays live-only: replay shows the recorded hash and does not recompute it.
   - **`results.md` section.** For each case with L1 runs, per run: `outcomeMetrics` from `eval/metrics.ts` (first-pass verify rate, mean attempts per stage, unresolved share, gate 7 incidents, flaky checks, and the verify wall time from the record), plus each stage's decision and gate 7 reasons, and the repo hash before and after. Gate 7 incidents and reasons are the ones HEAD's gate 7 gives on replay. When HEAD's gate 7 rejects a patch the recorded run kept, the row shows the recorded decision unchanged and marks the stage plainly (for example "kept, rejected by HEAD's gate 7"), that stage's gate 7 reasons count in gate 7 incidents, and the stage does not count as a "kept patch whose checks pass" for the acceptance criterion (D61 item 4). The section stays a pure function of HEAD's tree (D17), and L1 runs never count toward N or the pack gate's recall (INV-77).
   - **Coverage gap wording.** The same PR rewords the `django-upgrade` entry in `eval/cases/coverage-gaps.json` to name M12 instead of M10, and regenerates `eval/results.md`, which renders it.

   **Live-run handover (D39, D41).** The L1 runs need a live host session on the maintainer's key, on at least 2 of the Next.js cases whose `case.json` declares `checks` (today `nextjs-bigcommerce-subscription-foundation-51`, `nextjs-couchers-web-9893` and `nextjs-neotree-editor-165`), with the M7 host (Cursor/databricks-claude-sonnet-4-6) unless the maintainer says otherwise. The builder prepares the tooling and the run instructions, then stops and hands over, as M7 did. Per D61:
   - Every live L1 run made is committed, whatever its outcome. Each case's L1 set lands whole in one PR, because it is frozen after that PR (INV-45).
   - If fewer than 2 cases end with kept patches whose checks pass, the results are reported as they are and raised with the maintainer. No case is added silently to make up the count.

## Files and modules

`scripts/check-core-untouched.ts`, `src/pipeline/agentsSnippet.ts`, plus `src/pipeline/ingest.ts`, `src/security/denyList.ts` and `src/verify/checks.ts` (separate PR), `examples/AGENTS.snippet.md`, `eval/schema.ts`, `eval/load.ts`, `eval/metrics.ts`, `eval/replay.ts`, `eval/results.ts`, `eval/results.md`, `eval/cases/coverage-gaps.json`, `scripts/export-run.ts`, `src/verify/testIntegrity.ts` (only if replay builds trees in memory) and `eval/runs/<nextjs ids>/v1/l1/**` (task 10), `CONTRIBUTING.md`, `AI_POLICY.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`, `plugin/**`, `README.md`, `docs/demo/{script.md,demo.gif}`, `test/unit/agentsSnippet.test.ts`, `test/unit/eval/l1.test.ts`, `test/permissions/{agents-snippet-cannot-widen,repo-checks-need-trust}.test.ts`.

## Tests

- **AGENTS.md snippet:**
  - It parses only the dedicated block.
  - `planner_deny` adds entries.
  - Permissions: `!.env`, `../outside`, absolute paths, `C:\outside`, `\\server\share` and `foo\..\..\outside` are rejected, and the boundary is unchanged (`agents-snippet-cannot-widen`). A pathological `**` glob and a glob past the length or entry cap are rejected and not compiled. A chain of single `*` under the limits is accepted, and a scan over 200-character names stays under a second. Ingesting one repo again with one engine adds no glob twice. A snippet of twice the cap ingested twice by one engine leaves exactly the cap of its globs, and the cap rejection is logged on both calls. The matcher gives the old regex's answers on ordinary globs (`test/unit/denyGlob.test.ts`).
  - Checks from the snippet are ignored without `--trust-repo-checks`, and CLI flags override them (`repo-checks-need-trust`). A second repo does not replace the first adopted set.
  - A missing file is handled. The section ends at the next `## ` heading.
  - Without `confirm_target`, a snippet target that does not match the request is a question and no run. With `confirm_target: true`, the run uses the requested target.
- **L1 evidence (`test/unit/eval/l1.test.ts`):**
  - replaying a recorded L1 set calls no model, network or command: a throwing spawn and a throwing `fetch` are never reached
  - replay re-runs HEAD's gate 7 on the recorded patches: a recorded patch that adds a `.skip` shows that gate 7 reason in the L1 section, and disabling that rule in gate 7 changes the section
  - a recorded kept patch that HEAD's gate 7 rejects is marked in the section and does not count toward the acceptance count
  - the L1 section of `results.md` is byte-stable across two generations, and other cases' L1 rows are byte-identical after a run is added to one case
  - an L1 set never changes N or recall
  - a missing case checkout still fails closed with `case_commit_unavailable`
- **Plugin:** the generated bundle matches the packs (drift check).
- **Regression:** the full eval reruns for the Next.js pack. Its engine worst-case pooled recall must not fall below the low end of its noise band in `eval/results.md` on the base branch, first recorded in M7, which M7's CI pack gate checks (D17).

## Acceptance criteria

- The AGENTS.md snippet works when present, is optional, provably cannot widen the boundary, and cannot add checks without the trust flag.
- The open-source files and plugin bundle exist, and the README follows the order above, states its limits and claims only what exists.
- The demo script reproduces the reject-then-pass flow, the gate 7 rejection and a clean `git status`.
- The final name is recorded in `docs/design.md`.
- `eval/results.md` shows the Next.js pack with the baseline comparison and its misses, and the L1 outcomes of at least 2 Next.js golden cases with kept patches whose checks pass (M8's first acceptance criterion); a stage HEAD's gate 7 rejects on replay does not count (D61 item 4). The source repo hash is unchanged after each L1 run, as each run's record shows. If fewer than 2 cases reach that, this criterion is not met: the results are reported as they are and the maintainer decides (D61).

## Risks

- **AGENTS.md as an injection vector** (instructions or commands in the file). Mitigation: only three structured keys are parsed, the rest of the file is ignored, deny entries can only restrict, and checks need the trust flag.
- **The demo overstates capability.** Mitigation: use a real repo, show unresolved and needs-human items honestly, and put no metrics on screen that are not in `eval/results.md`.
- **v0.1 claims more generality than it shows.** With one pack, "a general engine" is a design aim, not a measured result. Mitigation: the README names one pack, says Django is v0.2, and makes no "any migration" claim (C8).
- **The L1 cases need network or services to install and test.** Mitigation: they are the cases' own declared checks, run at L1 as a user's would be. A check that fails at baseline is reported, never hidden (D49).

## Dependencies

- M3 (pack tooling, for the plugin), M7 (the eval harness), M8 (checks, codemod registry, gate 7, the L1 store records), M9 (needs-human section and report for the demo), M1 (deny list and boundary for the snippet).

## Must not break

The Next.js pack results, all gates including gate 7, the permissions suite (with the new snippet tests), prompt immutability and the repo hash.
