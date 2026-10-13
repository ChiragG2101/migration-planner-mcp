# M1 - MCP skeleton, scan_repo, event log, path boundary and read-only rule

**PRD refs:** sections 6.1, 6.2, 7 (audit trail), 7A, 11, 13. **Done when:** it works from Claude Code or Cursor, the permissions tests pass, and the run is recorded.

## Scope

- In scope:
  - a stdio MCP server that registers `scan_repo`
  - the ingest step, which produces a run ID
  - the SQLite event spine
  - the full security layer (path boundary, deny list, level flag, a single safe-write choke point)
  - the permissions test suite
- Out of scope: usage finding (M2), the rule pack (M3), Context7 (M4), findings (M5).

The security layer is built here, first, so that every later tool inherits it rather than having it bolted on later.

## Tasks

1. **Project setup.** `package.json` (ESM, Node >= 22, `bin: migration-planner-mcp`), `tsconfig.json` (strict), Vitest, ESLint, and these scripts: `build`, `test`, `typecheck`, `lint`, `test:permissions`. Pin the MCP SDK version after checking its README.
2. **Server entrypoint (`src/server.ts`).** Use the stdio transport and register tools from `src/tools/index.ts`. The server prints the server version, and later the pack name and version, to stderr at startup, never to stdout, which is the protocol channel.
3. **CLI flags (`src/cli.ts`):**
   - `--out <dir>`: default `.migration-planner/`, resolved outside the source tree, for example a sibling of the repo or under the user's cache dir. The server refuses to start if `--out` resolves inside a repo passed at ingest.
   - `--level <0|1>`: default 0. Passing 2 is refused with "not built in v0.1".
   - `--db <path>`: default `<out>/store.sqlite`.
4. **Security layer (`src/security/`):**
   - `pathBoundary.ts`: `resolveInside(root, p)` calls `fs.realpath` on both root and target, rejects anything not under the root (which covers `..`, absolute paths and symlink escapes), and returns a branded `SafePath` type. Every read API takes `SafePath` only.
   - `denyList.ts`: default denies are `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.npmrc`, `.git/` internals except HEAD and refs metadata, and `node_modules/` contents except `package.json`. It exposes `isDenied(SafePath)`. User additions are a hook for M9 (AGENTS.md); they can only add entries.
   - `level.ts`: holds the immutable process-level autonomy level, set once at startup. `assertLevel(n)` throws `PermissionError`.
   - `safeWrite.ts`: the **only** module that writes files. It resolves the target with `resolveInside(outDir, p)`. It refuses any target inside a registered repo root, even if the repo sits inside `outDir`. Callers declare a level for each write, and it checks that level.
   - An ESLint rule restricts `fs.writeFile*`, `fs.mkdir*`, `fs.rm*`, `fs.rename*`, `fs.symlink*`, `fs.copyFile*` and their `promises` variants, plus `child_process`, `execa` and `node:worker_threads` spawning scripts, to `src/security/` (and the store, for SQLite only).
5. **Ingest (`src/pipeline/ingest.ts`):**
   - Inputs: `repo_path`, `source {name, version?}`, `target {name, version?}`.
   - Rejects vague input. If source or target is missing or not a known library name, it returns a structured question instead of a run. It does not guess.
   - Resolves the installed source version from the lockfile only (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`). If several lockfiles or workspace packages disagree, it returns an ambiguity question listing the candidates.
   - Reads git state by parsing `.git/HEAD` and refs directly, with no `git` subprocess (C3). It records whether the tree is dirty only when that can be determined without executing anything. Otherwise it records "unknown". **Decision to record:** dirty detection needs the git index; parse it with a pure-JS reader, or mark it unknown. Never shell out.
   - Run ID = ULID. Idempotency key = hash(repo realpath, HEAD commit, source, target, pack version, prompt version). Re-ingesting the same key returns the existing run.
6. **`scan_repo` tool (`src/tools/scanRepo.ts` with `src/analysis/scanner.ts`):**
   - Workspaces: npm, pnpm and yarn workspaces. Each package gets its `package.json`.
   - Entrypoints: `main`, `module`, `exports`, `bin`, plus a heuristic for server files (`app.listen`) that is labelled `heuristic`.
   - Dependency versions: declared range plus the resolved lockfile version.
   - Test setup: the test runner from dependencies and config files, the test globs, and the `test` script **as text** (it is never executed).
   - TS config: `tsconfig.json` chain, `module`, `target` and paths.
   - Size limits: max files, max bytes per file, and total bytes. Skipped files are listed explicitly with a reason (failure matrix: Context builder).
   - Output: structured JSON, also stored in SQLite under the run.
7. **Event spine (`src/store/`):**
   - Tables: `runs(id, created_at, input_json, versions_json, idem_key, status)`, `events(id, run_id, ts, step, kind, payload_json, tokens_in, tokens_out)`, `files(run_id, path, sha256, size)`.
   - Migrations are versioned SQL files. `PRAGMA journal_mode=WAL`.
   - Every tool call writes `tool.start` and `tool.end` events, plus `tool.error` events carrying the `PermissionError` details.
8. **Repo hash script (`scripts/repo-hash.ts`).** A deterministic hash of every file under a root, honouring `.gitignore`-free full listing but skipping `.git/objects` for speed. Used by tests and later by the eval.
9. **Host wiring docs.** Add the Claude Code (`claude mcp add ...`) and Cursor (`.cursor/mcp.json`) config snippets to `docs/design.md`, so the demo command can be reproduced.

## Files and modules

`package.json`, `tsconfig.json`, `.eslintrc.*`, `src/server.ts`, `src/cli.ts`, `src/tools/{index,scanRepo}.ts`, `src/analysis/scanner.ts`, `src/pipeline/ingest.ts`, `src/security/{pathBoundary,denyList,level,safeWrite,errors}.ts`, `src/store/{db,events,runs}.ts`, `src/store/migrations/001_init.sql`, `scripts/repo-hash.ts`, `test/fixtures/express-basic/`, `test/fixtures/escape/` (built at test time with symlinks), `test/unit/*.test.ts`, `test/permissions/*.test.ts`.

## Tests

- **Permissions suite (`test/permissions/`, which gates every milestone from now on):**
  - `no-repo-write`: every tool runs against the fixture, and the repo hash is identical before and after.
  - `write-outside-out-dir`: `safeWrite` to `../x`, to an absolute path and into the repo root all throw `PermissionError`.
  - `path-escape`: `..` traversal, an absolute path, a symlink to `/etc` and a symlink to a sibling directory are all rejected by `resolveInside`.
  - `deny-list`: `.env`, `.env.local`, `id_rsa` and `*.pem` are never read, even when requested directly by path.
  - `no-exec`: a static test asserts that `child_process` is not imported outside `src/security/`. The lint rule exists and fails on a planted violation.
  - `level-2-refused`: `--level 2` exits non-zero with the "not built" message.
  - `out-inside-repo-refused`: the server refuses to start.
- **Unit tests:** lockfile parsing for npm, pnpm and yarn; workspace detection; ambiguity questions; vague-input rejection; idempotent run IDs; the size-limit skip list.
- **Integration:** an MCP client (the SDK's in-memory or stdio client) calls `scan_repo` on the fixture and checks the result and the events in SQLite.

## Acceptance criteria

- `npx tsx src/server.ts` connects from Claude Code and from Cursor. `scan_repo` on a real Express repo returns entrypoints, versions and test setup.
- The run and every tool call are visible as rows in `events`.
- The full permissions suite passes. Removing any single guard (for example, replacing `resolveInside` with `path.join`) makes at least one test fail. Verify this once, by hand, as a mutation check.
- The target repo hash is unchanged after the demo.

## Risks

- **SDK API churn (v2).** Mitigation: pin the version, and wrap registration in one module so a later upgrade touches a single file.
- **Detecting a dirty git tree without exec.** Mitigation: a pure parser, or report "unknown". Never shell out.
- **Symlink edge cases on Windows and macOS** (case-insensitive paths, junctions). Mitigation: realpath on both sides and a case-normalised comparison on case-insensitive filesystems. Add a CI matrix with Linux, macOS and Windows if it is free (GitHub Actions free tier on a public repo, or a local run otherwise).
- **Default `--out` placement.** Mitigation: never put the default inside the repo, and make the "outside the source tree" rule explicit in the startup log.

## Dependencies

- M0 spine docs (invariants INV-1 to INV-n map directly to the permissions tests).
- External: the MCP TS SDK, `typescript`, `zod`, the SQLite driver (see the overview decisions).

## Must not break

Nothing exists before M1. From M1 on, the permissions suite is part of every milestone gate.
