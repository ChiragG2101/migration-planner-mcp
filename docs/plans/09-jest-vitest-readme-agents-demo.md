# M9 - Second migration (Jest to Vitest), README, AGENTS.md snippet, demo

**PRD refs:** sections 4 (second rule pack), 9 (packs and skills), 14 (demo, README order, limits, AGENTS.md snippet), 15 (honest claims). **Done when:** the rule pack is added with **no core changes**.

## Scope

- In scope:
  - the Jest to Vitest rule pack, usage adapter, generated skill and references
  - eval cases for it
  - the AGENTS.md snippet reader at ingest
  - the final README
  - the 60 to 90 second demo
- Out of scope: npm publish and tagging (M10), third-party packs, and other languages.
- Cut order: if behind, the second migration is cut **second**, after L1. The README, the AGENTS.md snippet and the demo still ship.

## "No core changes" definition

Adding the pack may only touch:

- `rules/jest-to-vitest/**`
- one new usage adapter `src/analysis/usages/jest.ts`, registered in a single adapters list
- eval cases and fixtures
- docs

A CI check (`scripts/check-core-untouched.ts`) diffs the M9 pack PR against the protected paths: `src/pipeline/**`, `src/schema/**`, `src/security/**`, `src/store/**` and `src/tools/**` other than the registry line. It fails on any change. If the pack cannot be added without a core change, that is a design bug. Fix it in a separate, reviewed core PR **before** the pack PR, and record the fix in `docs/design.md`.

## Tasks

1. **Jest adapter (`src/analysis/usages/jest.ts`).** Uses the M2 `UsageAdapter` interface. It detects:
   - `jest.fn/mock/spyOn/useFakeTimers/requireActual/resetModules`
   - global `describe/it/test/expect/beforeEach` with no import (globals mode)
   - `@jest/globals` imports
   - `jest.config.*` and the `jest` key in `package.json`
   - `setupFiles`, `moduleNameMapper` and `transform` (babel-jest, ts-jest)
   - snapshot files
   - `__mocks__` directories
   - custom matchers (`expect.extend`)
   - `testEnvironment` (jsdom or node)
2. **Pack (`rules/jest-to-vitest/rules.json`, `CHANGELOG.md`, `references-src/`).**
   - Mappings: `jest.*` to `vi.*`; the globals config (`globals: true` or explicit imports); `moduleNameMapper` to `resolve.alias`; `transform` to native ESM and esbuild; `requireActual` to `vi.importActual` (async); automock differences; the snapshot format; timer API differences; and `testEnvironment` to `environment`.
   - `no_equivalent` entries where they apply.
   - The trigger is "Use when planning a Jest to Vitest migration in a TypeScript or JavaScript repo."
   - Build it with the same M3 generator and lint. Verify the mappings against current Vitest docs via Context7 (`scripts/verify-pack-docs.ts`).
3. **Jest to Vitest eval cases.** At least 2 golden cases (public PRs) plus a seeded repo (`eval/seeded/jest-tricky/`) with `requireActual`, `__mocks__`, `moduleNameMapper`, a custom matcher, fake timers and globals mode. Add them to `eval/results.md`.
4. **AGENTS.md snippet.**
   - `examples/AGENTS.snippet.md`: a short fenced block under a `## migration-planner` heading with three keys: `test_command`, `planner_deny` (a list of globs) and `targets` (for example `hono@^4`).
   - Reader (`src/pipeline/agentsSnippet.ts`, called from ingest). It reads `AGENTS.md` at the repo root via `SafePath`, if present, and parses only the fenced block under that heading.
     - `planner_deny` globs are **added** to the deny list. A glob that tries to un-deny (for example `!.env`) or point outside the root is rejected and logged.
     - `test_command` is used only as text, to prefill the `verify` hints. It is never executed (C3).
     - `targets` is checked against the user's request. A mismatch produces an ambiguity question, not a silent override.
   - The server works without it, and its absence is logged as "AGENTS.md snippet: not found".

   *Note:* this touches `src/pipeline/ingest.ts` and `src/security/denyList.ts`. Because it is a core change, land it in its own PR, separate from the Jest pack PR, so that the "no core changes" check stays meaningful for the pack.
5. **README (final), in the PRD section 14 order:**
   1. pitch
   2. demo GIF
   3. one-snippet install (with Claude Code and Cursor MCP config)
   4. example output (an excerpt from a real `MIGRATION_PLAN.md`)
   5. how it works (the ASCII diagram from PRD section 6)
   6. eval table with the baseline comparison, copied from `eval/results.md` with the misses linked
   7. **Limits**: TS/JS only, two migrations, plan only, read-only, no third-party packs
   8. how to add a rule pack (the generator, lint and changelog)
   9. companions (GitHub MCP, filesystem MCP, git MCP), with links checked against current docs
   10. the third-party pack trust limit, stated plainly

   The status stays "currently building" until M10 (C8).
6. **Demo (60 to 90 seconds; `docs/demo/script.md` plus a recorded GIF or MP4).** Show Claude Code on a real Express repo:
   1. `git status` is clean
   2. ask for a plan
   3. show the critic (`validate_plan`) rejecting a draft for an uncited claim (gate 3) or an evidence mismatch (gate 1)
   4. show the passing plan with file:line links and the "Needs human decision" section
   5. `git status` is still clean, and the repo hash matches

   Script it so it can be reproduced.

## Files and modules

`src/analysis/usages/jest.ts`, `src/analysis/usages/index.ts` (one registry line), `rules/jest-to-vitest/**`, `eval/cases/<jest ids>/**`, `eval/seeded/jest-tricky/**`, `scripts/check-core-untouched.ts`, `src/pipeline/agentsSnippet.ts`, `src/pipeline/ingest.ts` and `src/security/denyList.ts` (separate PR), `examples/AGENTS.snippet.md`, `README.md`, `docs/demo/{script.md,demo.gif}`, `test/unit/{jestAdapter,agentsSnippet}.test.ts`, `test/permissions/agents-snippet-cannot-widen.test.ts`.

## Tests

- **Jest adapter:** one test per usage kind, and recall on `jest-tricky` is recorded with a ratchet.
- **Pack:** the M3 lint and generator checks pass for the new pack, and pack versions are recorded per run.
- **No core changes:** `check-core-untouched` passes for the pack PR.
- **AGENTS.md snippet:**
  - It parses only the dedicated block.
  - `planner_deny` adds entries.
  - Permissions: `!.env`, `../outside` and absolute paths are rejected, and the boundary is unchanged (`agents-snippet-cannot-widen`).
  - `test_command` appears in the verify text but is never executed (a static test plus a spy that `child_process` is not called).
  - A missing file is handled.
- **Regression:** the full eval reruns (pack and prompt context changed). The Express results must not regress beyond the noise band recorded in M7.

## Acceptance criteria

- The Jest to Vitest pack, adapter and eval cases merge with `check-core-untouched` passing.
- `eval/results.md` includes both migrations and the baseline comparison, with misses listed.
- The AGENTS.md snippet works when present, is optional, and provably cannot widen the boundary.
- The README follows the PRD section 14 order, states its limits and claims only what exists.
- The demo script reproduces the reject-then-pass flow and a clean `git status`.

## Risks

- **A hidden core coupling surfaces** (for example, Express-specific assumptions in gates or staging). Mitigation: that is exactly what this milestone tests. Fix it in a separate core PR and record it.
- **Jest to Vitest staging differs** (config-first, then test files, not leaf-first by import graph). Mitigation: if staging needs a per-pack hint, add it as **pack data** (for example `staging: "config_first"`) supported by a generic core option, in the separate core PR.
- **AGENTS.md as an injection vector** (instructions in the snippet). Mitigation: only three structured keys are parsed, the rest of the file is ignored, and the snippet can only restrict.
- **The demo overstates capability.** Mitigation: use a real repo, show unresolved and needs-human items honestly, and put no metrics on screen that are not in `eval/results.md`.

## Dependencies

- M3 (pack tooling), M2 (the adapter interface), M7 (the eval harness), M8 (needs-human section for the demo), M1 (deny list and boundary for the snippet).

## Must not break

The Express pack results, all gates, the permissions suite (with the new snippet tests), prompt immutability and the repo hash.
