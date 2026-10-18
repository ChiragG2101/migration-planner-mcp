# Failure modes

The failure matrix from [`PRD.md`](PRD.md) §8, with a "test or check" column added. This is a living document: add a row when a new way things can go wrong is found or handled. When a real repo surprises the engine, add the row **and** a seeded or golden case for it (the quadrant rule, below).

**Quadrant use.** For each cell ask: what you know you don't know (add a test), what you will recognise on sight (add a check), and what you have never considered (add an eval case when a real repo surprises you).

**M0 note.** The "test or check" entries below are mostly *planned*: they name the guard that the owning milestone will add. The invariant IDs link to [`invariants.md`](invariants.md).

| Component | Engineering failures | LLM failures | Design response | Test or check |
| --- | --- | --- | --- | --- |
| Ingest | Monorepo with several lockfiles, dirty git tree, wrong version detected | Agent guesses versions | Resolve from lockfile only; ask when ambiguous | Version resolved from lockfile fixtures; ambiguous input refused with a question (M1) |
| Context builder | Dynamic imports, re-exports, generated code, huge repos, parse errors, Python dynamic attribute access | n/a (deterministic) | Report unparsed files explicitly; size limits; incremental cache; heuristic labels | Unparsed files listed in the scan output; seeded re-export/dynamic cases; recall measured on the seeded repo (M2) |
| Docs retrieval | Context7 rate limit, outage, wrong library ID, stale version | Agent cites a doc it never fetched | Cache; pin versions; gate 3; "docs unverified" marker | Offline/fallback test (Context7 down); gate 3 rejects uncited `doc_refs` (INV-17, M4/M6) |
| Specialists (lenses) | Output not matching schema, timeouts | Hallucinated APIs, vague advice, confident wrong severity | Narrow prompts; schema; evidence required; confidence field | Invalid lens output retried once then recorded as a gap; `agent_judgment` with no evidence rejected (INV-22, M5) |
| Aggregator | Duplicate or conflicting findings, lost findings | Merges findings that are actually different | Deterministic dedupe key; conflict log; flag uncovered usages | Dedupe-key unit tests; conflict takes higher severity and logs it; gate 2 coverage (INV-16, M6) |
| Gates | A check that passes wrongly (false pass) | Agent rewrites findings only to satisfy the gate | Gates test against real files; round cap; unresolved items stay visible | Each gate has a test that fails when the guard is removed; 3-round cap test; unresolved never marked passed (INV-15–21, M6/M8) |
| Verify loop | Flaky or slow tests, checks failing before any change, installs needing network, codemod crashes | Agent weakens or deletes tests to pass; agent tries to pass a command through a tool argument | Baseline run first; timeouts; retry cap; gate 7; commands from user config only | Weakened-test fixtures all rejected by gate 7 (INV-21); command-from-tool-argument refused (INV-8); baseline recorded before any stage (M8) |
| Emit | Plan too long to read | Padded prose | Needs-human section on top; per-stage summary | Emitted plan has a needs-human section and per-stage summaries; confidence-routing test (M9) |
| Permissions | Path traversal, symlink escape, write into the repo, process escaping the sandbox dir | Prompt or skill text tells the agent to edit files or run commands | Enforced in code; single spawn point; permissions tests | The whole `test/permissions/` suite (INV-1–9); repo hash unchanged after L1 (M1, M8) |
| Rule packs and skills | Outdated pack, malformed rule, drift between pack and skill, codemod version drift | Skill trigger too broad so it loads on unrelated tasks | One source file; version pins; narrow trigger; lint in CI | Pack schema rejects malformed/executable fields (INV-10); generated-file drift check (INV-24); skill lint for trigger + length; codemod versions pinned (INV-9) (M3, M8) |

## Added since the PRD

Rows found during the build go here, newest first.

| Component | Engineering failures | LLM failures | Design response | Test or check |
| --- | --- | --- | --- | --- |
| Ingest | A patch release of a checked release unit is refused as newer than the pack | n/a | `supported` compared by release unit (D13) | Ingest test: `5.2.7` and `15.3.2` accepted, `6.0` and `16.0.0` refused (INV-38, M3) |
| Rule packs and skills | Range composition off by one, or a version-scheme quirk (Django `4.2` vs `4.10`) | n/a | Composition and version comparison in core, table-tested on both schemes (D10) | `compose.test.ts`, `versions.test.ts` (INV-37, INV-38, M3) |
| Rule packs and skills | A draft rule, or one from memory, reaches a user's plan | Contributor's agent fills in a match or fix wrongly | Only `reviewed` rules load; drafts come from the official notes; a second reviewer; the pack update report (D10, D11) | Loader skips drafts (INV-36); review-milestone checks review and report (M3) |
| Rule packs and skills | Official notes change format and the drafter or report misreads them | n/a | Plain parser that reports unknown sections instead of guessing; recorded fixtures (D11) | Release-notes parser tests (M3) |
| Rule packs and skills | User's installed version is older than the knowledge goes back | n/a | "Changes before X were not checked" note; size can't be `none` (D10) | Sizing test with an install older than `covered_from` (M3) |
| Eval | Golden-case finder proposes a bad case (wrong parent, versions from the PR title, no licence) | n/a | Mechanical checks in the finder; human vetting; candidates never added automatically; re-checker before evals (D11) | Finder and re-checker tests on recorded GitHub responses (INV-41, M7) |
| Docs retrieval | A look-alike host or a forked repo passes as official | Agent registers a doc from an unofficial site, or one it never fetched | Label `fetched_by` and `official` from the `doc_sources` of the pack's libraries; the agent is out of the path only in server-side mode, and even then the content is Context7's (D9, D14) | Source-label tests, including look-alike hosts (INV-35, M4) |
| Size and scope | The full process runs on an upgrade that touches no code (over-engineering) | n/a | Sizing from the facts: `none`, `small`, `full` (D8) | `next-clean` sizes as `none` (M3) |
| Size and scope | `none` given wrongly: the scan missed files, or a behaviour change has no matching code | n/a | `none` needs a complete scan and no peer conflicts; behaviour changes are always listed (D8) | Each `none` condition flips the verdict when broken (INV-32, M3) |
| Size and scope | n/a | Agent uses scope to drop items that fail a gate, or invents scope options | Fixed options only; frozen at the first lens packet or the first `merge_findings`, whichever comes first; excluded breaking items go to "Review first" (D8, D12) | `scope-cannot-widen` permissions test; routing test (INV-33, INV-34, M3, M9) |
| Eval | A golden PR itself misses a required change, so a correct finding is scored as a false alarm | n/a | Hand-reviewed `annotations.json`; headline from raw truth, adjusted figure beside it (D7) | Annotations leave headline metrics byte-identical (INV-30, M7) |
| Eval | Golden cases repeat one repo shape, so a count hides gaps | n/a | Coverage matrix; empty cells reported as gaps (D7) | `results.md` lists empty matrix cells (M7) |
| Rule packs and skills | Pack covers only the target major's changes and misses removals from releases in between | n/a | Rules span every release in the range; every rule has a seeded case (D5, D6) | Pack lint: rule with no seeded case fails (INV-28, M3, M10) |
| Aggregator | Fixes that work on the old version are bundled into the bump, so the bump stage is large and hard to roll back | n/a | `lands_on` per rule; prep stages before the bump (D5) | Gate 5 `bad-g5` fixtures (INV-29, M6) |
| Specialists (lenses) | Partly migrated repo: usages already in target form | Lens proposes changes to code already migrated, or "fixes" debt the migration does not require | Mark already-migrated usages out of scope; findings need a rule or doc citation (D6) | Seeded `no_change` and `no_finding` entries scored as false alarms (INV-31, M2, M7, M10) |
