# M2 - Language adapters, import graphs, find_usages for Next.js, usage index

**PRD refs:** sections 2 (the mechanical rows), 3 (exhaustive on facts), 6 (context build, language adapters), 8 (Context builder), 10.3 (seeded defects), 11. **Done when:** recall on the seeded-defect repo is reported.

## Scope

- In scope:
  - a `LanguageAdapter` interface with two implementations: TS/JS (TypeScript compiler API) and Python (tree-sitter WASM)
  - a text scanner for non-code files (config, templates) that packs can use
  - import graphs for both languages, stored in SQLite
  - a `UsageAdapter` interface, and the Next.js usage adapter for pack 1
  - a deterministic `find_usages` that finds every usage the pack cares about, including indirect ones, with file:line, context and a snippet hash
  - the seeded-defect repo `next-tricky` with a recall report
- Out of scope: deciding what each usage means (risk is M3, findings are M5), and the Django usage adapter (M10). The Python language adapter is built here, in the core, so that M10 can add Django without core changes.

## Tasks

1. **Language adapter interface (`src/lang/adapter.ts`).** `LanguageAdapter { id, extensions, parse(SafePath) => SyntaxTree, imports(tree) => ImportEdge[], symbols(tree) => Symbol[] }`. Files are read only through `SafePath` and the deny list, so the M1 boundary holds inside every parser. The M1 size limits apply.
2. **TS/JS adapter (`src/lang/ts/`).** Build a TypeScript `Program` from the repo's tsconfig, or an inferred config for JS (`allowJs`, `checkJs: false`, JSX enabled). A custom `CompilerHost` reads only through `SafePath`.
   - Imports: `import`/`export ... from`, `require()`, `import()` with a string literal, and barrel re-exports (`export * from`). Path aliases from tsconfig `paths` are resolved, but only to targets inside the root.
3. **Python adapter (`src/lang/python/`).** tree-sitter WASM with the Python grammar, loaded from the package (no network, no native build).
   - Imports: `import a.b`, `from a import b`, relative imports resolved against package roots (`__init__.py`, `pyproject.toml` package settings), and `importlib.import_module("literal")`.
   - **String references:** dotted-path strings that name a module or class (`"app.middleware.Auth"`), which frameworks such as Django use in settings. Recorded as `string_ref` edges with `confidence: heuristic`, so packs can follow them.
   - No type information: attribute access through variables is labelled `heuristic`.
4. **Text scanner (`src/lang/text.ts`).** For files no language adapter owns (for example `next.config.*` fallbacks, HTML templates, `.env.example` is never read since it matches the deny list), a line-based scanner that packs drive with literal patterns. Results are always `confidence: heuristic`.
5. **Unresolved imports.** Dynamic `import(expr)`, `require(expr)` and `importlib.import_module(expr)` with non-literal arguments are recorded as `unresolved_dynamic` usages. They are reported, never dropped (failure matrix: Context builder).
6. **Import graph store.** `imports(run_id, repo_id, from_file, to_module, to_file, kind, line, lang)`. M6 reuses it for gate 5, and M3 for fan-in.
7. **Usage adapter interface (`src/analysis/usages/adapter.ts`).** `UsageAdapter { id, languages[], match_kinds[], detect(ctx) => Usage[] }`, where `ctx` gives access to the parsed trees, the import graph and the text scanner. `match_kinds[]` declares which typed rule matches (M3: `import`, `call`, `config_key`, …) the adapter can find; the M3 lint rejects a pack whose rules need a kind its adapter does not declare. Adapters are registered in a single list (`src/analysis/usages/index.ts`), so M10 adds Django with one line.
8. **Next.js usage adapter (`src/analysis/usages/nextjs.ts`).** The starting list below is a draft. **Every item is checked against the current Next.js and React upgrade guides through Context7 (M4) before the M3 rules are written**, and the list is trimmed or extended to match.
   - Request APIs that became async in recent majors: `cookies()`, `headers()`, `draftMode()` from `next/headers`, and the `params` and `searchParams` props in pages, layouts, route handlers and `generateMetadata`.
   - Caching behaviour: `fetch` calls in server components and route handlers, `GET` route handlers, and segment config exports (`dynamic`, `revalidate`, `fetchCache`, `runtime`).
   - Config: `next.config.*` keys (experimental flags, image config), `middleware.*`.
   - Removed or renamed imports and packages (for example `@next/font`).
   - React changes required by the Next.js major: legacy root APIs (`ReactDOM.render`, `hydrate`), `findDOMNode`, string refs, `propTypes` and `defaultProps` on function components, legacy context, form-state hooks that moved packages.
   - Dependencies whose peer ranges exclude the target React or Next.js version, read from the lockfile and labelled `peer_conflict`.
   - Indirect usages: wrappers that call these APIs, re-exports through barrels, and type-only imports labelled `type_only`.
   - Each `Usage` has: `id` (a stable hash of repo, file, start, kind and symbol), `repo_id`, `file`, `line_start`, `line_end`, `snippet_hash`, `kind`, `symbol`, `context` (at most N lines, deny-list checked), `via` (the import chain for indirect usages) and `confidence` (`exact` or `heuristic`).
9. **Snippet hashing (`src/analysis/snippet.ts`).** One normalisation function (trim trailing whitespace, normalise line endings to LF) shared with gate 1 in M6. It is defined once so the two can never disagree, and it is language-independent.
10. **Usage index (`src/store/usages.ts`).** Tables `usages` and `symbols(run_id, repo_id, name, file, line, kind)`. Query by kind, by file and by symbol. Incremental cache keyed on file sha256, so re-runs on an unchanged file skip parsing.
11. **`find_usages` (`src/core/findUsages.ts`, tool `src/tools/findUsages.ts`, CLI `usages`).**
    - Input: `run_id` and optional filters.
    - Output: paginated usages plus a summary (counts per kind, `unparsed_files[]`, `unresolved_dynamic[]`, `skipped_by_limit[]`).
    - The response never truncates silently. If it paginates, it says so and gives the total.
12. **Seeded-defect repo (`eval/seeded/next-tricky/`).** A small Next.js app on an older major with planted hard cases, each tagged in a `ground_truth.json` (id, file, line, kind, `expect`; M3 adds `rule_id`). `expect` is `change` (the migration must change it), `no_change` (a pack usage that must be found but needs no change) or `no_finding` (not a pack usage; no finding may cite it). See `docs/design.md` D6.
    - `cookies()` called through a helper in another module
    - `params` destructured in a layout and passed down to a client component
    - a route handler relying on implicit `GET` caching
    - a barrel that re-exports a wrapper around `headers()`
    - a dynamic `import()` of a page module by variable
    - a class component using string refs
    - a function component with `defaultProps`
    - a dependency with a peer range that excludes the target React
    - a `next.config` with a removed experimental flag
    - a type-only import of a changed type
    - **Existing-state cases** (`expect` in brackets):
      - an API deprecated in an earlier major, never cleaned up, and removed inside the range [`change`]
      - an import of a framework internal (`next/dist/...`) whose path changes in the target [`change`]
      - a file already in the target form, for example one that already awaits `cookies()` [`no_change`: it must be found, then marked out of scope as already migrated]
      - decoys: old-style code the target still supports, for example a still-supported legacy pattern or a lint-level smell [`no_finding`]
13. **Python adapter fixture (`test/fixtures/python-imports/`).** A small package with absolute, relative, `importlib` and settings-string references, used only for adapter unit tests. The Django seeded repo comes in M10.
14. **Recall script (`eval/seeded/recall.ts`).** Compares `find_usages` output with the ground truth and prints recall per kind and overall, plus the misses. Recall counts `change` and `no_change` entries, since both are usages that must be found. `no_finding` entries are scored at the plan level in M7. Writes `eval/seeded/recall.md`. It is pack-independent, so M10 reuses it.

## Files and modules

`src/lang/{adapter,text}.ts`, `src/lang/ts/{program,imports,symbols}.ts`, `src/lang/python/{parser,imports,symbols}.ts`, `src/analysis/snippet.ts`, `src/analysis/usages/{adapter,index,nextjs}.ts`, `src/store/usages.ts`, `src/store/migrations/002_usages.sql`, `src/core/findUsages.ts`, `src/tools/findUsages.ts`, `src/cli/usages.ts`, `eval/seeded/next-tricky/**`, `eval/seeded/recall.ts`, `eval/seeded/recall.md`, `test/fixtures/python-imports/**`, `test/unit/{lang,usages}/*.test.ts`.

## Tests

- **TS adapter:** re-export chains of depth 1 to 3, `require` and ESM interop, tsconfig `paths`, JSX files. A dynamic import is recorded as unresolved.
- **Python adapter:** absolute, relative and `importlib` imports resolve; a dotted settings string becomes a `string_ref` edge; a non-literal `import_module` is unresolved; syntax errors put the file in `unparsed_files` instead of failing the run.
- **Next.js adapter:** one test per usage kind, using small inline fixtures.
- **Snippet hash stability:** CRLF vs LF and trailing spaces give the same hash, and a real edit changes the hash, for both TS and Python files.
- **Permissions:** the full suite still passes. A deny-listed file is never parsed even when imported. Neither `CompilerHost` nor the Python adapter can read outside the root (a test plants a tsconfig `paths` entry and a Python relative import pointing at `../outside`).
- **Recall:** this is the smoke eval. CI fails if overall recall on `next-tricky` drops below the recorded value (a ratchet that only moves up).

## Acceptance criteria

- `eval/seeded/recall.md` exists with per-kind recall. The first target is 100% on direct usages and at least 80% on indirect ones, with every miss listed.
- Every unparsed file and unresolved dynamic import shows up in the summary. Zero silent drops, which is checked by a test that counts total spans.
- `find_usages` on a real Next.js repo finishes within the M1 size limits, and the time is recorded as an event.
- The Python adapter builds an import graph for a real Django repo within the size limits, even though no Django usage adapter exists yet.

## Risks

- **Indirect-usage recall is the core value and the hardest part.** Mitigation: the seeded repo grows whenever a real repo surprises us (failure-matrix quadrant rule). Add embeddings only if recall measurably misses things. Not in M2.
- **The draft Next.js list is wrong for the current major.** Mitigation: it is checked against the upgrade guide via Context7 before M3 writes rules, and the seeded repo is adjusted with it.
- **TS program build is slow on large monorepos.** Mitigation: a per-package program, the incremental cache and size limits.
- **Python without types gives weak resolution.** Mitigation: heuristic labels, which feed M3 risk and M9 routing; recall is measured on the Django seeded repo in M10.
- **tree-sitter WASM loading problems on some platforms.** Mitigation: test on the CI matrix; the pure-JS fallback is recorded in the overview decisions.

## Dependencies

- M1: `SafePath`, the deny list, the store, campaign and repo IDs and run IDs.

## Must not break

The M1 permissions suite, the repo hash check and `scan_repo` output.
