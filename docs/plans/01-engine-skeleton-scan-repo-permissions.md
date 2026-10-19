# M1 - Engine skeleton, CLI and MCP adapters, scan_repo, event log, path boundary and read-only rule

**PRD refs:** sections 6 (architecture, ingest, context build), 7 (audit trail), 7A, 11, 13. **Done when:** `scan_repo` works from the CLI, Claude Code and Cursor, the permissions tests pass, and the run is recorded.

## Scope

- In scope:
  - a core engine library (`src/core/`) with two thin adapters: a CLI and a stdio MCP server, both exposing `scan_repo`
  - the ingest step, which produces a run ID under a campaign and repo ID
  - `scan_repo` for JS/TS and Python projects
  - the SQLite event spine
  - the full security layer (path boundary, deny list, level flag, a single safe-write choke point, and an `exec.ts` stub that refuses everything)
  - the permissions test suite
- Out of scope: usage finding and language adapters (M2), the rule pack (M3), Context7 (M4), findings (M5), any execution (M8).

The security layer is built here, first, so that every later tool inherits it rather than having it bolted on later.

## Tasks

1. **Project setup.** `package.json` (ESM, Node >= 22, `bin` with the working name), `tsconfig.json` (strict), Vitest, ESLint, `LICENSE` (Apache-2.0), and these scripts: `build`, `test`, `typecheck`, `lint`, `test:permissions`. Pin the MCP SDK version after checking its README.
2. **Core API (`src/core/index.ts`).** Plain async functions (`ingest`, `scanRepo`, later `findUsages` and so on) that take typed input and return typed output. The CLI and MCP adapters call only these. No adapter contains logic.
3. **MCP adapter (`src/server.ts`).** Uses the stdio transport and registers tools from `src/tools/index.ts`, each a thin wrapper that validates input with Zod and calls `src/core/`. The server prints its version, and later the pack name and version, to stderr at startup, never to stdout, which is the protocol channel.
4. **CLI adapter (`src/cli/`).**
   - Commands mirror tools: `scan <repo> --source <lib@ver> --target <lib@ver>` in M1, others added per milestone. Output is JSON by default, with `--format text` for people.
   - Shared flags:
     - `--out <dir>`: default `.migration-planner/`, resolved outside the source tree, for example a sibling of the repo or under the user's cache dir. The engine refuses to start if `--out` resolves inside a repo passed at ingest.
     - `--level <0|1>`: default 0. Passing 2 is refused with "not built in v0.1". Level 1 is accepted but every exec still refuses until M8.
     - `--db <path>`: default `<out>/store.sqlite`.
   - `mcp` subcommand starts the MCP adapter with the same flags, so one binary covers both.
5. **Security layer (`src/security/`):**
   - `pathBoundary.ts`: `resolveInside(root, p)` calls `fs.realpath` on both root and target, rejects anything not under the root (which covers `..`, absolute paths and symlink escapes), and returns a branded `SafePath` type that also carries the `repo_id`. Every read API takes `SafePath` only.
   - `denyList.ts`: default denies are `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.npmrc`, `.pypirc`, `.git/` internals except HEAD and refs metadata, `node_modules/` contents except `package.json`, and virtualenv folders (`.venv/`, `venv/`, `site-packages/`). It exposes `isDenied(SafePath)`. User additions are a hook for M10 (AGENTS.md); they can only add entries.
   - `level.ts`: holds the immutable process-level autonomy level, set once at startup. `assertLevel(n)` throws `PermissionError`.
   - `safeWrite.ts`: the **only** module that writes files. It resolves the target with `resolveInside(outDir, p)`. It refuses any target inside a registered repo root, even if the repo sits inside `outDir`. Callers declare a level for each write, and it checks that level.
   - `exec.ts`: the **only** module allowed to spawn a process. In M1 it is a stub whose single function throws `PermissionError("execution not available")` at every level. M8 implements it. Its existence now means the lint rule and the no-exec test have a single allowed target from day one.
   - An ESLint rule restricts `fs.writeFile*`, `fs.mkdir*`, `fs.rm*`, `fs.rename*`, `fs.symlink*`, `fs.copyFile*` and their `promises` variants to `src/security/` (and the store, for SQLite only), and restricts `child_process`, `execa` and `node:worker_threads` to `src/security/exec.ts`. The rule covers `src/`. Maintainer tools under `scripts/` and the eval tooling are outside the engine (they write files and run `git` and `gh`); an import lint from M3 stops `src/` importing them.
6. **Ingest (`src/pipeline/ingest.ts`):**
   - Inputs: `repo_path` (exactly one; a list of more than one is refused with "multi-repo campaigns not built in v0.1"), `source {name, version?}`, `target {name, version?}`, optional `campaign_id`.
   - Rejects vague input. If source or target is missing or not a known library name, it returns a structured question instead of a run. It does not guess.
   - Resolves the installed source version from lockfiles only: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, and pinned `requirements*.txt`. If several lockfiles or workspace packages disagree, it returns an ambiguity question listing the candidates.
   - Reads git state by parsing `.git/HEAD` and refs directly, with no `git` subprocess (C3). It records whether the tree is dirty only when that can be determined without executing anything. Otherwise it records "unknown". **Decision to record:** dirty detection needs the git index; parse it with a pure-JS reader, or mark it unknown. Never shell out.
   - IDs: `campaign_id` (created if absent), `repo_id` = hash of the repo realpath, run ID = ULID. Idempotency key = hash(repo realpath, HEAD commit, source, target, pack version, prompt version). Re-ingesting the same key returns the existing run.
7. **`scan_repo` (`src/core/scanRepo.ts` with `src/analysis/scanner.ts`):**
   - Workspaces: npm, pnpm and yarn workspaces; uv workspaces and multiple `pyproject.toml` files. Each package gets its manifest.
   - Entrypoints, JS/TS: `main`, `module`, `exports`, `bin`, Next.js app markers (`next.config.*`, `app/`, `pages/`), plus a heuristic for server files labelled `heuristic`.
   - Entrypoints, Python: `[project.scripts]`, `manage.py`, Django settings modules (found from `DJANGO_SETTINGS_MODULE` text in `manage.py`, `wsgi.py`, `asgi.py`), labelled `heuristic` where inferred.
   - Dependency versions: declared range plus the resolved lockfile version.
   - Test setup: the test runner from dependencies and config files (Jest, Vitest, Playwright, pytest, `pytest-django`, Django's runner), the test globs, and the `test` script **as text** (it is never executed).
   - Config: `tsconfig.json` chain, `module`, `target` and paths; `pyproject.toml` tool sections relevant to tests and typing.
   - Size limits: max files, max bytes per file, and total bytes. Skipped files are listed explicitly with a reason (failure matrix: Context builder).
   - Output: structured JSON, also stored in SQLite under the run.
8. **Event spine (`src/store/`):**
   - Tables: `campaigns(id, created_at, name)`, `repos(id, campaign_id, root_realpath)`, `runs(id, campaign_id, repo_id, created_at, input_json, versions_json, idem_key, status)`, `events(id, run_id, ts, step, kind, payload_json, tokens_in, tokens_out)`, `files(run_id, repo_id, path, sha256, size)`.
   - Migrations are versioned SQL files. `PRAGMA journal_mode=WAL`.
   - Every tool call or CLI command writes `tool.start` and `tool.end` events, plus `tool.error` events carrying the `PermissionError` details.
9. **Repo hash script (`scripts/repo-hash.ts`).** A deterministic hash of every file under a root (a full listing that ignores `.gitignore`), skipping `.git/objects` for speed. Used by tests and later by the eval and the verify loop.
10. **Host wiring docs.** Add the CLI usage, the Claude Code (`claude mcp add ...`) and Cursor (`.cursor/mcp.json`) config snippets to `docs/design.md`, so the demo command can be reproduced.

## Files and modules

`package.json`, `tsconfig.json`, `.eslintrc.*`, `LICENSE`, `src/core/{index,scanRepo}.ts`, `src/cli/{index,scan}.ts`, `src/server.ts`, `src/tools/{index,scanRepo}.ts`, `src/analysis/scanner.ts`, `src/analysis/manifests/{node,python}.ts`, `src/pipeline/ingest.ts`, `src/security/{pathBoundary,denyList,level,safeWrite,exec,errors}.ts`, `src/store/{db,events,runs,campaigns}.ts`, `src/store/migrations/001_init.sql`, `scripts/repo-hash.ts`, `test/fixtures/{next-basic,django-basic}/`, `test/fixtures/escape/` (built at test time with symlinks), `test/unit/*.test.ts`, `test/permissions/*.test.ts`.

## Tests

- **Permissions suite (`test/permissions/`, which gates every milestone from now on):**
  - `no-repo-write`: every tool and CLI command runs against both fixtures, and the repo hash is identical before and after.
  - `write-outside-out-dir`: `safeWrite` to `../x`, to an absolute path and into the repo root all throw `PermissionError`.
  - `path-escape`: `..` traversal, an absolute path, a symlink to `/etc` and a symlink to a sibling directory are all rejected by `resolveInside`.
  - `deny-list`: `.env`, `.env.local`, `id_rsa`, `*.pem` and `.pypirc` are never read, even when requested directly by path.
  - `no-exec`: a static test asserts that `child_process` is not imported anywhere except `src/security/exec.ts`. The lint rule exists and fails on a planted violation. Calling `exec.ts` at level 0 and level 1 both throw in M1.
  - `single-write-point`: a static test asserts that no `node:fs` write API (`writeFile`, `appendFile`, `mkdir`, `rm`, `rename`, `copyFile`, `createWriteStream` and their promise forms) is imported anywhere except `src/security/safeWrite.ts`. The lint rule fails on a planted violation.
  - `level-2-refused`: `--level 2` exits non-zero with the "not built" message.
  - `level-not-raisable`: no tool input schema has a level field, and a tool call carrying `level: 1` at level 0 leaves the level at 0, so `assertLevel(1)` still throws.
  - `out-inside-repo-refused`: the engine refuses to start.
  - `multi-repo-refused`: ingest with two repo paths returns the "not built in v0.1" error.
- **Store only (`test/unit/store-only.test.ts`):** a static test asserts that `node:sqlite` and `better-sqlite3` are imported only under `src/store/`, and that `package.json` has no other database or vector-store dependency.
- **Unit tests:** lockfile parsing for npm, pnpm, yarn, uv, poetry and requirements; workspace detection; Django settings detection; ambiguity questions; vague-input rejection; idempotent run IDs; the size-limit skip list.
- **stdout (`test/unit/stdout-protocol-only.test.ts`):** the MCP server is started over stdio and `scan_repo` is called; every line on stdout parses as a JSON-RPC message, and the startup banner and the logs appear on stderr.
- **Integration:** an MCP client (the SDK's in-memory or stdio client) calls `scan_repo` on both fixtures and checks the result and the events in SQLite. The CLI `scan` command on the same fixtures produces the same JSON.

## Acceptance criteria

- The CLI `scan` command and the MCP server (from Claude Code and from Cursor) both return entrypoints, versions and test setup for a real Next.js repo and a real Django repo.
- The run and every tool call are visible as rows in `events`, with campaign and repo IDs.
- The full permissions suite passes. Removing any single guard (for example, replacing `resolveInside` with `path.join`) makes at least one test fail. Verify this once, by hand, as a mutation check.
- The target repo hash is unchanged after the demo.

## Risks

- **SDK API churn (v2).** Mitigation: pin the version, and wrap registration in one module so a later upgrade touches a single file.
- **Adapters drifting apart.** Mitigation: adapters contain no logic; an integration test checks CLI and MCP give the same output.
- **Detecting a dirty git tree without exec.** Mitigation: a pure parser, or report "unknown". Never shell out.
- **Python manifest variety** (setup.cfg, setup.py, Pipfile). Mitigation: support the lockfile formats listed; report anything else as "unrecognised manifest" rather than guessing.
- **Symlink edge cases on Windows and macOS** (case-insensitive paths, junctions). Mitigation: realpath on both sides and a case-normalised comparison on case-insensitive filesystems. Add a CI matrix with Linux, macOS and Windows if it is free.
- **Default `--out` placement.** Mitigation: never put the default inside the repo, and make the "outside the source tree" rule explicit in the startup log.

## Dependencies

- M0 spine docs (invariants map directly to the permissions tests).
- External: the MCP TS SDK, `typescript`, `zod`, the SQLite driver (see the overview decisions).

## Must not break

Nothing exists before M1. From M1 on, the permissions suite is part of every milestone gate.
