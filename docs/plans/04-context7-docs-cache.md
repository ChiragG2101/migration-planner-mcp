# M4 - Context7 integration, retrieval log, cache

**PRD refs:** sections 1 (Context7 pairing), 6 (reliability layer), 7 gate 3, 7A (network), 8 (Docs retrieval row), 9, 11. **Done when:** it works with Context7 down, and the fallback is tested.

## Scope

- In scope: `get_migration_docs`, which acts as a cache, formatter and **retrieval log**. Every doc the agent may cite gets a recorded `doc_id` and URL for this run. This includes the agent-side composition: the prompt (M5) tells the host agent to call Context7, then register what it fetched through this tool. Also in scope are the offline and rate-limit fallbacks to the cache plus the rule pack, and the "docs unverified" marker.
- Stretch (cut first if behind): the server calls Context7 directly as an MCP client.
- Out of scope: any paid tier dependency, and sending repo content anywhere.

## Design

Two modes share one log:

1. **Agent-side (MVP).** The host agent calls Context7's `resolve-library-id` and `query-docs` itself, then calls `get_migration_docs({ run_id, register: [{ library, version, topic, url, content }] })`. The server normalises and caches each doc, assigns `doc_id = sha256(library@version|url|content_hash)` and writes a `docs.retrieved` event. Only registered docs are citable (gate 3 in M6).
2. **Server-side (stretch).** If `CONTEXT7_API_KEY` or a local Context7 package is configured, `get_migration_docs({ run_id, query: [{ library, version, symbol }] })` calls Context7 itself, with a typed outbound payload of library, version and symbol only (C6).

Both modes fall back in the same order: the fresh cache, then the stale cache (marked `stale`), then the rule-pack `doc_hints` and references (marked `docs_unverified`).

## Tasks

1. **Store (`src/store/docs.ts`, migration `003_docs.sql`).** Tables:
   - `doc_cache(doc_id, library, version, topic, url, content, fetched_at, source)`: global across runs and keyed by library@version so it can be reused offline.
   - `run_docs(run_id, doc_id, mode, status)`: per-run and used by gate 3, where status is `fresh`, `stale` or `unverified`.
2. **`get_migration_docs` tool (`src/tools/getMigrationDocs.ts`).**
   - Accepts `register` (agent-side) or `query` (server-side), and returns formatted snippets with `doc_id`, `url`, `library`, `version` and `status`.
   - Formats the output for compact context: a per-symbol section with the old side and the new side.
   - Version pinning: it refuses a register or query whose version does not match the versions resolved at ingest (major.minor). The error tells the agent the expected version (failure matrix: stale version).
3. **Context7 client (`src/docs/context7.ts`, stretch).**
   - Uses the MCP client from the official SDK against `https://mcp.context7.com/mcp` with a bearer key from the env, or the local package. Re-check the tool names (`resolve-library-id`, `query-docs`) against the upstream README at the start of M4.
   - Timeouts. Detects 429 (and its MCP equivalent) and backs off once, then falls back.
   - The outbound payload type has no free-text field. A unit test serialises every call and asserts that only allowed keys exist (C6).
   - **Never** sends file paths, snippets or code.
4. **Network guard (`src/security/network.ts`).** A module-level allowlist containing only the Context7 host. Any other outbound request throws. Context7 is disabled unless configured, and a test asserts that no network is used when it is unconfigured.
5. **Reliability.** Mark findings that cite only `stale` or `unverified` docs as "docs unverified" (consumed in M5 and shown in M8's report). Record `docs.fallback` events with the reason (timeout, 429, offline or unconfigured).
6. **Rule-pack cross-check script (`scripts/verify-pack-docs.ts`).** Optional and manual. With Context7 configured, it fetches the docs for each rule's `doc_hints` and writes a report of rules whose mapping is not reflected in the docs, which feeds pack PR review (M3 risk). It never runs in default CI because of network use and C1.

## Files and modules

`src/tools/getMigrationDocs.ts`, `src/docs/{context7,cache,format}.ts`, `src/security/network.ts`, `src/store/docs.ts`, `src/store/migrations/003_docs.sql`, `scripts/verify-pack-docs.ts`, `test/unit/docs/*.test.ts`, `test/fixtures/context7/` (recorded responses).

## Tests

- **Registration:** registered docs get stable `doc_id`s, and re-registering is idempotent.
- **Version pin:** registering Hono v3 docs when ingest resolved v4 is rejected with the expected version in the message.
- **Fallback matrix (`test/unit/docs/fallback.test.ts`):** using a fake transport, it covers Context7 up, timeout, 429, offline, unconfigured, cache-fresh, cache-stale and empty cache. Each gives the expected status and fallback event. **This is the milestone's "done when" test.**
- **Network:** no outbound calls when unconfigured. Calling a non-allowlisted host throws. The outbound payload contains only `library`, `version` and `symbol`.
- **Permissions:** the full suite. The cache writes go only to the store under `--out`.

## Acceptance criteria

- With Context7 unreachable, a full `scan_repo` → `find_usages` → `get_rule_pack` → `get_migration_docs` sequence completes. Docs come back marked `stale` or `docs_unverified`, and a `docs.fallback` event is recorded.
- Every doc returned to the agent has a `doc_id` present in `run_docs` for that run.
- No network traffic happens without explicit configuration (verified by test).

## Risks

- **Context7 tool names or auth change.** Mitigation: a thin adapter, re-checked at M4 start, plus recorded fixtures.
- **Community docs can be wrong (PRD section 9).** Mitigation: docs are treated as cited evidence, not truth. The rule pack and the gates stay authoritative for structure.
- **The agent "registers" a doc it did not actually fetch, with made-up content.** Mitigation: the registered URL must be on a Context7 or official-docs host allowlist and the content must be non-empty. In server-side mode the content is fetched by the server. Document this residual trust gap in `docs/failure-modes.md`.
- **Cache growth.** Mitigation: a size cap with LRU eviction. Never evict docs referenced by a run in the last N runs.

## Dependencies

- M1 (store, security) is required. M3 (`doc_hints` and references) is needed for the fallback content. M4 can run in parallel with M2 and M3 if the fallback-content wiring lands last.

## Must not break

The permissions suite, offline operation of all earlier tools, and the repo hash.
