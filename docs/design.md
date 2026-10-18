# docs/design.md

Decisions taken during the build. The [PRD](PRD.md) is the source of truth for *what* is built; this file records *why* a given option was chosen when the plans left it open. The cross-cutting defaults table lives in [`plans/00-overview.md`](plans/00-overview.md); entries here either confirm those defaults or resolve a question the overview left open.

Rationale and background research live in `.private/research/` (gitignored). This file states the decision and a short reason only, so it can be public.

## 2026-10-18: tech stack review before M1

Three open questions from `.private/research/decisions.md` (the "harness-agnostic repo layout" entry, item 2), resolved before M1 so the stack is fixed when the first code lands. Recommendations, not surveys.

### D1 - Does a Python-first user need Node? (`npx` install friction for Django teams)

**Decision: yes, the engine stays Node-only, distributed over `npx`, and we accept that a Python-only team installs Node to run it. We do not ship a Python distribution or a PyPI entry point in v0.1.**

Why:

- The engine is one codebase in TypeScript on Node 22 (overview "Runtime" default, confirmed below). Shipping a second runtime for the Python *pack* would split the core, which directly violates the "one engine, several adapters" shape (C7, overview "Engine shape"). The Python pack is pack *data* plus a tree-sitter WASM adapter; it is not Python code and needs no Python interpreter.
- The friction is a one-time `node`/`npx` presence, not a per-run cost. This is the same bet REA makes - one `npx` command across Claude Code, Codex and Cursor - and it is why that tool spread (`landscape.md`, REA section). Django developers upgrading across an LTS boundary already install toolchains (`django-upgrade`, `tox`, CI runners); Node is a comparable one-time step.
- The alternative (a Python wheel wrapping the same logic, or a port) doubles the maintenance surface, the test matrix and the permissions audit for a second language that exists mainly to *prove the engine is general*. That trade is not worth it in v0.1.

Consequences and mitigations:

- The README prerequisites must name Node 22 LTS explicitly and show the `npx` one-liner, so a Python-first user is not surprised.
- The user's own declared check commands for a Django repo (`python -m pytest`, `tox`, and so on) still run in their environment inside the sandbox at L1; the engine shells out to them through `exec.ts`, it does not provide Python. That is already how C3/C9 are specified.
- Revisit only if a Django/Python audience materially adopts the tool and the Node prerequisite is the measured blocker. A thin PyPI launcher that shells to `npx` is the cheapest future option; a port is not on the table.

### D2 - ast-grep vs per-language parsers

**Decision: per-language parsers, as the overview already defaults - the TypeScript compiler API for TS/JS and tree-sitter WASM for Python. ast-grep is not adopted as the core analysis engine. It may later be wrapped as an *optional, allowlisted codemod* (a `verify/codemods.ts` entry), never as the thing that resolves usages.**

Why (two independent blockers, each sufficient):

1. **ast-grep is syntax-only and cannot resolve re-exports or cross-file symbols.** Its own docs state that export/visibility matching "is syntax-only ... does not follow re-export chains or resolve module visibility across files," and that import outlines are "a local syntax view ... does not resolve the imported module." The whole point of `find_usages` and the TS compiler API default is *real symbol and re-export resolution* (overview "TS/JS parser"): catching a Next.js API used through a re-export or an alias is exactly the "missed usages" the engine claims to own over the mechanical codemods (`landscape.md`, "our gap"). A syntax matcher would miss precisely the cases that justify the project.
2. **ast-grep ships as a native NAPI binary (`@ast-grep/napi`).** That reintroduces the native-build and per-platform-binary install friction we deliberately removed by choosing tree-sitter *WASM* for Python ("no native build, no subprocess", C3 and overview "Python parser"). Taking a native binary into the core would weaken an install-friction and portability decision already made.

What we keep from the investigation:

- tree-sitter (via `web-tree-sitter`, WASM) remains the Python parser. ast-grep is itself built on tree-sitter grammars, so the structural-matching capability we might want is already reachable through our own WASM path without the native binary.
- If a future pack wants ast-grep's rule-rewriting for a *mechanical* step, it enters through the codemod allowlist at a pinned version like any other codemod (C9), run only at L1 inside the sandbox. It never becomes a source of usage facts, because facts must be resolvable, not pattern-matched.

### D3 - Single package vs monorepo

**Decision: a single npm package with the `src/` layout the overview already describes. Not a monorepo, and not multiple published packages, in v0.1.**

Why:

- The architecture is explicitly *one core with thin adapters* (CLI, MCP server, generated skills) and *packs as data*, not as separately published code. The target source layout in the overview is already a single tree under `src/` with `rules/<pack>/` as data directories. A monorepo would add workspace tooling, cross-package versioning and release orchestration to buy separation the design does not need, because the adapters contain no logic and the packs are JSON/Markdown.
- A single package is the lowest-friction `npx` target (overview "Package manager"), which is the same reason D1 lands on Node-over-npx. One package means one `npx <name>` entry point for both the CLI and the MCP config, one version to pin, one permissions audit surface.
- "Pack as the unit of contribution" (`landscape.md`, open-source section) is satisfied by `rules/<pack>/` directories plus the "no core changes" check (`scripts/check-core-untouched.ts`, M10), not by separate packages. A contributor adds a directory and golden cases; they do not publish a package. CI eval is the reviewer.

Consequences:

- The eventual Claude Code plugin bundle and the generated product skills are build artifacts emitted from the single package (M10), not independent packages.
- Revisit only if a pack ever needs to ship heavy, pack-specific native dependencies that would bloat the core install; at that point a optional-dependency or plugin-download model is cheaper than a full monorepo. Not a v0.1 concern.

### D4 - What counts as a Django "LTS-to-LTS" golden case (M0 task 6)

**Decision: a Django golden case qualifies for M0 if it *lands on* an LTS release (the `to` version is an LTS: 2.2, 3.2, 4.2, 5.2, …), even if the `from` version is not itself an LTS. A case where both `from` and `to` are LTS is preferred and is tagged `lts-to-lts`; a case that only lands on an LTS is tagged `to-lts`. The ≥2 Django minimum is read as "≥2 cases that exercise a real cross-major upgrade landing on an LTS", not "≥2 strict LTS→LTS".**

Why:

- The two M0 Django candidates are `ror-api` (3.2.25 → 4.2.30, both LTS: a genuine LTS→LTS) and `thunderstore` (3.1.7 → 4.2.30). Django 3.1 is **not** an LTS release — Django's LTS line is 2.2, 3.2, 4.2, 5.2 — so `thunderstore` is an upgrade *to* 4.2 LTS from a non-LTS release, not strict LTS→LTS. The earlier records and `eval/cases/README.md` wrongly called it `lts-to-lts`; that is corrected (tag `to-lts`, and the README status/line fixed).
- The pack's job is a cross-major upgrade that ends on a supported LTS; both cases exercise exactly that (3.x → 4.2 LTS). For M0, whose only acceptance bar is "cases exist with a checkout-able base commit", requiring the *source* to also be an LTS would reject a perfectly good upgrade for a reason the engine does not care about.

Consequences and the standing follow-up:

- This makes M0's ≥2 Django minimum met with one strict LTS→LTS (`ror-api`) and one to-LTS (`thunderstore`). It is a widening of the plan's wording, recorded here per working-rule 2 ("decisions you make go in `docs/design.md`").
- **Follow-up, not optional:** before M7 derives truth and M10 locks the Django pack scope, add a *second genuine LTS→LTS* case (another 3.2 → 4.2, or a 4.2 → 5.2). Tracked in `eval/cases/README.md` "Open items". If the maintainer prefers strict LTS→LTS only for M0, that is a scope call to raise now rather than silently.

### Confirmation of the overview defaults

Reviewing the above did not change any standing default in [`plans/00-overview.md`](plans/00-overview.md). Confirmed as-is for M1: Node 22 LTS / TypeScript strict / ESM runtime; core-plus-adapters engine shape; official MCP TS SDK v2 over stdio (pin the exact version, re-check at each milestone); `node:sqlite` with a `better-sqlite3` fallback; the TypeScript compiler API for TS/JS; tree-sitter WASM for Python; Zod schemas; Vitest; ESLint with the fs-write / `child_process` import restriction; npm; Apache-2.0; working name `migration-planner-mcp`.
