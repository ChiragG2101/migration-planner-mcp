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

Rows found during the build go here, newest first. None yet — M0 is pre-code.
