# M2 - find_usages for Express, usage index

**PRD refs:** sections 2 (the mechanical rows), 3 (exhaustive on facts), 6.2, 8 (Context builder), 10.3 (seeded defects), 11. **Done when:** recall on the seeded-defect repo is reported.

## Scope

- In scope: a deterministic `find_usages` that finds every usage of the source library, including indirect ones, with file:line, context and a snippet hash; a SQLite usage and symbol index; and the seeded-defect fixture repo with a recall report.
- Out of scope: deciding what each usage means. Risk is M3 and findings are M5.

## Tasks

1. **Program builder (`src/analysis/program.ts`).** Build a TypeScript `Program` from the repo's tsconfig, or an inferred config for JS (`allowJs`, `checkJs: false`). Read files only through a custom `CompilerHost` that goes through `SafePath` and the deny list, so the boundary from M1 holds inside the compiler too. Respect the M1 size limits.
2. **Import and re-export graph (`src/analysis/importGraph.ts`).**
   - Covers `import`/`export ... from`, `require()`, `import()` with a string literal, and barrel re-exports (`export * from`).
   - Dynamic `import(expr)` and `require(expr)` with non-literal arguments are recorded as `unresolved_dynamic` usages. They are reported, never dropped (failure matrix: Context builder).
   - The graph is stored in SQLite as `imports(run_id, from_file, to_module, to_file, kind, line)`. M6 reuses it for gate 5.
3. **Usage finder (`src/analysis/usages/express.ts`):** an adapter interface `UsageAdapter { library, detect(program, graph) => Usage[] }`, so M9 can add Jest without core changes.
   - Direct: `express()`, `express.Router()`, `express.json/urlencoded/static/raw/text`, `app.use/get/post/.../all/route/param/listen/set/engine`, `router.*`.
   - Handler shape: functions passed to the above that take `(req, res, next)` or `(err, req, res, next)`, which marks error middleware. Accesses to `req.*` and `res.*` inside them (`res.send/json/status/redirect/render/locals/sendFile/download/cookie`, `req.body/params/query/headers/cookies/ip`).
   - Indirect: wrapped helpers (a local function that returns or receives an Express router or app), re-exports through barrels, and type-only usages (`import type { Request } from 'express'`) labelled `type_only`.
   - Third-party middleware: packages whose own `package.json` lists `express` as a dependency or peer dependency, or a known list (`cors`, `helmet`, `body-parser`, `morgan`, `express-session`, `multer`, `passport`, `compression`, `cookie-parser`). These are emitted as `third_party_middleware` usages.
   - Each `Usage` has: `id` (a stable hash of file, start, kind and symbol), `file`, `line_start`, `line_end`, `snippet_hash` (sha256 of the normalised source span), `kind`, `symbol`, `context` (at most N lines, deny-list checked), `via` (the import chain for indirect usages) and `confidence` (`exact` or `heuristic`).
4. **Snippet hashing (`src/analysis/snippet.ts`).** One normalisation function (trim trailing whitespace, normalise line endings to LF) shared with gate 1 in M6. It is defined once so the two can never disagree.
5. **Usage index (`src/store/usages.ts`).** Tables `usages` and `symbols(run_id, name, file, line, kind)`. Query by kind, by file and by symbol. Incremental cache keyed on file sha256, so re-runs on an unchanged file skip parsing.
6. **`find_usages` tool (`src/tools/findUsages.ts`).**
   - Input: `run_id` and optional filters.
   - Output: paginated usages plus a summary (counts per kind, `unparsed_files[]`, `unresolved_dynamic[]`, `skipped_by_limit[]`).
   - The response never truncates silently. If it paginates, it says so and gives the total.
7. **Seeded-defect repo (`eval/seeded/express-tricky/`).** A small Express app with planted hard cases, each tagged in a `ground_truth.json` (id, file, line, kind):
   - custom middleware that mutates `req`
   - error middleware with 4 arguments
   - streaming with `res.write` and `res.pipe`
   - a router re-exported via a barrel
   - a helper that wraps `app.get`
   - a dynamic `require` of a route folder
   - `res.locals` used as global state
   - `app.set('trust proxy')`
   - a third-party `multer` upload
   - `import type { Request }` only
8. **Recall script (`eval/seeded/recall.ts`).** Compares `find_usages` output with the ground truth and prints recall per kind and overall, plus the misses. Writes `eval/seeded/recall.md`.

## Files and modules

`src/analysis/{program,importGraph,snippet}.ts`, `src/analysis/usages/{adapter,express}.ts`, `src/store/usages.ts`, `src/store/migrations/002_usages.sql`, `src/tools/findUsages.ts`, `eval/seeded/express-tricky/**`, `eval/seeded/recall.ts`, `eval/seeded/recall.md`, `test/unit/usages/*.test.ts`.

## Tests

- **Unit:** one test per usage kind, using small inline fixtures. Re-export chains of depth 1 to 3. `require` and ESM interop. A dynamic import is recorded as unresolved. A deny-listed file is never parsed, even when it is imported.
- **Snippet hash stability:** CRLF vs LF and trailing spaces give the same hash, and a real edit changes the hash.
- **Permissions:** the full suite still passes, and the `CompilerHost` cannot read outside the root (a test plants a tsconfig `paths` entry pointing at `../outside`).
- **Recall:** this is the smoke eval. CI fails if overall recall on `express-tricky` drops below the recorded value (a ratchet that only moves up).

## Acceptance criteria

- `eval/seeded/recall.md` exists with per-kind recall. The first target is 100% on direct usages and at least 80% on indirect ones, with every miss listed.
- Every unparsed file and unresolved dynamic import shows up in the summary. Zero silent drops, which is checked by a test that counts total spans.
- `find_usages` on a real Express repo finishes within the M1 size limits, and the time is recorded as an event.

## Risks

- **Indirect-usage recall is the core value and the hardest part.** Mitigation: the seeded repo grows whenever a real repo surprises us (failure-matrix quadrant rule). Add embeddings only if recall measurably misses things (PRD section 6.2). Not in M2.
- **TS program build is slow on large monorepos.** Mitigation: a per-package program, the incremental cache and size limits. tree-sitter is the fallback (see the overview).
- **JS repos without types give weaker resolution.** Mitigation: heuristic usages are labelled `confidence: heuristic`, which feeds M3 risk and M8 routing.

## Dependencies

- M1: `SafePath`, the deny list, the store and the run IDs.

## Must not break

The M1 permissions suite, the repo hash check and `scan_repo` output.
