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

- The README prerequisites must name Node 22 LTS (22.13 or later, D18) explicitly and show the `npx` one-liner, so a Python-first user is not surprised.
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

- The architecture is explicitly *one core with thin adapters* (CLI, MCP server, generated skills) and *packs as data*, not as separately published code. The target source layout in the overview is already a single tree under `src/` with the data directories beside it (`rules/<pack>/` at the time; `knowledge/` and `packs/` since D10). A monorepo would add workspace tooling, cross-package versioning and release orchestration to buy separation the design does not need, because the adapters contain no logic and the packs are JSON/Markdown.
- A single package is the lowest-friction `npx` target (overview "Package manager"), which is the same reason D1 lands on Node-over-npx. One package means one `npx <name>` entry point for both the CLI and the MCP config, one version to pin, one permissions audit surface.
- "Pack as the unit of contribution" (`landscape.md`, open-source section) is satisfied by data directories (`knowledge/` and `packs/` since D10) plus the "no core changes" check (`scripts/check-core-untouched.ts`, M10), not by separate packages. A contributor adds a directory and golden cases; they do not publish a package. CI eval is the reviewer.

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

## 2026-10-18: coverage and the existing state of the target repo

Plan amendments made after the M0 review, to M2, M3, M6, M7 and M10. They answer two questions: how a few golden cases can give real coverage, and how the engine treats bad practices already in the target repo.

### D5 - Rules span the whole version range, and fixes that work on the source version land first

**Decision: a pack's rules cover the removals of every release in its range, not only the target major. Each rule declares `lands_on: source | target`. The aggregator puts `source` fixes in prep stages before the version bump, and gate 5 checks that order. A finding with no matched rule defaults to `target`.**

*Revised by D10:* `lands_on` is no longer typed into each rule. It is derived per run from the rule's `replacement_since` and the installed version.

Why:

- The commonest mandatory change in a long-lived repo is a deprecation the team ignored for years that the target finally removes. Django drops an API about two feature releases after deprecating it. Next.js and React do the same across majors. A pack that only reads the target's release notes misses exactly this debt.
- Fixes that already work on the old version can be merged and verified with the old stack still in place. That keeps the bump stage small and easy to roll back, which is Django's own advice (clear the deprecation warnings, then upgrade).
- `target` is the safe default for an unmatched finding: staging it late can only cost an extra stage, while staging it early can break the build.

### D6 - Every rule has a seeded case, and seeded repos test what must *not* be flagged

**Decision: the pack lint fails if a rule has no `expect: change` seeded case, or if a code-usage kind has no indirect seeded entry. Seeded ground truth labels each entry `change`, `no_change` (already in target form: found, then marked out of scope) or `no_finding` (a decoy the migration does not require). Changes proposed on the last two count as false alarms.**

Why:

- Golden PRs show how the engine does on real code. They can't show breadth, because a handful of PRs exercises only a few of a pack's rules. Seeded cases are cheap and can cover every rule, so the lint makes that coverage a rule, not a hope.
- Selectivity (PRD §3) has two failure directions. Recall alone rewards an engine that flags everything. Decoys and already-migrated files measure the other direction: rewriting code the migration does not need to touch.

### D7 - Golden cases are picked for spread, and a PR's own misses never improve the headline

**Decision: golden cases are chosen to fill a coverage matrix (router, monorepo, version hops, test runner, data layer, diff size), and empty cells are reported as known gaps. When a reviewer confirms that a real PR missed a required change, the case gets a hand-reviewed `annotations.json` entry. That adds an adjusted figure and a "PR missed" list, but the headline metrics stay computed from raw truth.**

Why:

- Five cases that repeat the same shape count as one case. A matrix makes the gaps visible instead of hidden behind a count.
- A merged PR is imperfect ground truth. But letting annotations rewrite the headline would let the project grade its own homework, which is the same risk gate 7 guards against. Raw numbers stay primary, and the adjustment is shown beside them with each entry linked.

## 2026-10-18: size the migration and ask about scope before planning

### D8 - A sizing and scope step after the facts are built

**Decision: after `scan_repo`, `find_usages`, `get_rule_pack` and `assess_risk`, the engine runs `propose_scope`. It sizes the migration as `none`, `small` or `full` from the facts and offers a few scope questions, only when the facts make them relevant. `set_scope` records the answers. Scope can only narrow, takes fixed options, and is frozen once planning starts. Rules gain `necessity: breaks | deprecated`. PRD sections 2, 6, 7, 9 and 11 are updated, along with M3, M5, M6 and M9.**

*Revised by D10:* `necessity` is no longer typed into each rule. It is derived per run from the rule's events in the installed-to-target range.

*Revised by D12:* scope freezes at the first lens packet or the first `merge_findings`, whichever comes first, so a `none` run freezes too.

Why:

- **Over-engineering small upgrades.** Running four lenses and gate rounds on an upgrade that touches no code is waste, and users would stop trusting the tool for big upgrades if it is slow on trivial ones. The engine already holds the facts to prove a migration is small, so sizing is a deterministic computation, not a model's guess.
- **`none` has to be earned.** It needs a complete scan, zero matched usages and no peer conflicts, and it still lists the pack's behaviour changes. Some upgrades change behaviour with no code change (for example caching defaults in Next.js 15), so "nothing matched" alone is not proof of "nothing to do".
- **Users often want less than everything:** one app out of three, a stop at the major in between, or only the changes that break. Asking after the scan means questions are concrete ("these 3 apps") rather than a generic form, and only relevant ones are asked.
- **Narrow-only, fixed options, frozen once planning starts.** These close the obvious abuses. Scope can't widen the path boundary, the level or the commands (C4, C5, C9), and it can't be used mid-run to drop items that fail gate 2. Excluding something that breaks on the target is allowed, because it is the user's call, but it goes to "Review first".
- **Defaults keep CI and non-interactive runs working:** full scope at the computed size.

What it costs: two tools, one rule field, a `combined` lens for `small` runs, and an engine-built plan for `none` runs. The four-lens path is unchanged.

## 2026-10-18: where docs come from

### D9 - Label who fetched each doc and whether it is official

**Decision: every doc a run uses records `fetched_by` (`engine` or `agent`) and `official` (its URL falls under one of the pack's `doc_sources` prefixes). An agent-registered doc from outside those prefixes is `unverified`, and findings citing only such docs carry the "docs unverified" badge. Gate 3 itself is unchanged.**

*Revised by D10:* `doc_sources` live in each library's `library.json`, not in the pack. A pack's official prefixes are those of its libraries.

*Revised by D14:* `fetched_by` gains a third value, `knowledge`, for fallback links.

Why:

- In the agent-side mode (the v0.1 default), the agent fetches a doc and hands the engine both the link and the text. Gate 3 then proves only that a doc was *registered* in this run, not that it is real or authoritative. Without labels, a doc from a random blog and one from nextjs.org look the same in the plan.
- A prefix list per pack is a few lines that rarely change (a docs site and a repo folder). It is not a copy of the docs, so it adds almost no maintenance.
- **Stated limit:** an official URL with made-up content can't be caught without fetching it. The server-side mode, where the engine fetches the doc itself, takes the agent out of the path, but the content still comes from Context7, which is community-contributed (PRD section 9). Neither mode checks content against the official source. The run report says so rather than implying more.

## 2026-10-18: how knowledge and packs are structured

### D10 - Knowledge per library, kept by release; thin packs that compose it

**Decision: replace the one-file-per-pack `rules/<pack>/rules.json` with two layers.**

- **`knowledge/<ecosystem>/<library>/`** holds the facts. `library.json` gives the version scheme, release unit, LTS list, `covered_from`, official doc sources, release-notes location and codemods. There is one `releases/<release>.json` per release, which may be split by area when large.
- **`packs/<pack>/pack.json`** names its libraries (a primary and companions), the checked range, the usage adapter, staging and trigger. It holds no rules.

The engine composes the rules for any installed-to-target range at run time, and derives `necessity` and `lands_on` from each rule's events. Rules have typed matches and one official source link, and only `reviewed` rules load. Both version schemes (`semver`, `pep440`) and every match kind both v0.1 packs need are built in M3.

Why:

- **Ranges must compose.** A user on Next 13 going to 15 needs 14's changes and 15's. A fixed per-pack range forces either a pack per pair or rewriting the pack each release. Facts kept by release, composed at run time, cover every pair inside the checked range.
- **Maintenance grows by appending.** A new release is one new file plus a pack version bump. Old release files only change to fix a mistake, recorded in the library changelog. That bounds the "never-ending maintenance" worry: work is per release of the framework, and finished releases stay finished.
- **Libraries are shared.** React's changes are written once and used by any pack that needs them, instead of being copied into the Next.js pack.
- **Fewer hand judgments.** Whether a change breaks on the target, and whether its fix can land before the upgrade, follow from when it was deprecated, removed and replaced. Deriving them removes two fields that were easy to get wrong (revising D5 and D8).
- **Different ecosystems differ in data, not code.** Next.js counts majors, Django counts X.Y feature releases with LTS releases and a deprecation timeline. Both are expressed as a version scheme plus a release unit.
- **No core change for pack 2.** The `pep440` scheme and the Python and Django match kinds (`attribute`, `setting`, `string_ref`, template tags and filters) are in M3, so M10's "no core changes" check can hold. `src/rules/**` is added to its protected paths.
- **Thin, not a docs mirror.** Each rule stores one official link, not doc text. Live docs are still looked up at run time through Context7.

Caveats accepted:

- Composition and version comparison are new core logic. They are covered by table-driven tests on both schemes (inclusive and exclusive bounds, patch-level events, pre-release refusal).
- Conditional peer requirements (Next 15's app router needs React 19, its pages router doesn't) are expressed as `peer_requirement` rules tied to a match, with a `requires {library, range}` field (D13). That is more complex than a flat list.
- A user older than `covered_from` gets a "changes before X were not checked" note, and the size can't be `none`.
- A future pack needing a new version scheme or match kind is a core change, reviewed as code. That is by design: packs are data and can't run code.

### D11 - Maintainer tools that draft knowledge and find golden cases, with a human always deciding

**Decision: four maintainer tools under `scripts/`, outside the engine:**

- the **release drafter** (`knowledge:draft`, M3)
- the **pack update report** (`pack:report`, M3), which replaces the planned Context7-based cross-check and the committed docs checklist
- the **golden-case finder** (`cases:find`, M7)
- the **case re-checker** (`cases:verify`, M7)

They may use the network, never run in default CI, and `src/` never imports from `scripts/`. A test-example stub generator was considered and left out, because the useful seeded cases are the indirect ones, which need a person.

Why:

- **The slow, error-prone part of maintenance is mechanical.** That means reading release notes item by item, and checking a PR's licence, parentage and lockfile versions. The M0 golden-case review found errors in exactly these mechanical facts. Tools do them repeatably.
- **Every tool stops at a human decision.** The drafter writes `draft` rules that don't load until reviewed. The finder writes candidates to a gitignored folder and never adds a case. The report is attached to the PR, not committed, so no doc checklist has to be maintained.
- **No model in the tools (C7 in spirit).** The drafter and report split notes with a plain parser. The judgment part (writing the match, the fix, the severity) is done by the contributor's own agent with the `add-release-knowledge` skill, the same way the product uses the host agent.
- **Official sources, not Context7, for the pack check.** Context7 snippets are community-contributed (PRD section 9). The pack's own correctness is checked against the primary source.

*Revised by D15:* the import lint also stops `src/` importing from `eval/`.

## 2026-10-18: fixes from the plan review of the knowledge and scope changes

An independent review of the plan changes (`1f6c12e..7ad5bbf`) found gaps that would have stopped M2, M3, M4, M6 or M10 being built as written. The decisions below close them.

### D12 - `none` runs cover their usages and freeze scope too

**Decision: when the aggregator builds a `none` plan, it marks every usage in the run out of scope with the reason `none: no rule in range`. Scope freezes at whichever comes first: the first lens packet or the first `merge_findings`.**

Why:

- `none` means no usage matches a composed rule, but `find_usages` can still find usages, for example a segment config export when no caching rule falls in (S, T]. With no lens to cover them, gate 2 would fail three times and push them into `unresolved` on every `none` run. The engine already knows why they need no change, so it writes the reason itself, the same way it writes `scope:` reasons.
- Freezing only at the first lens packet left `none` runs, which fetch no packet, open to `set_scope` between gate rounds. That is exactly the abuse D8 set out to close.

*Revised by D16:* the reason is now `no rule in range`, and the aggregator writes it in every run size, not only for `none`.

### D13 - Peer requirements name their companion range; the checked range bounds a run; packs name their seeded repo

**Decision:**

- A `peer_requirement` rule carries `requires {library, range}`. A companion is composed to the lowest version that satisfies every `requires` in range, and conditional requirements are applied too, with a note when their match finds nothing.
- The pack's `supported` range bounds a run. Both bounds are compared by release unit, so `5.2.7` counts as `5.2` and `15.3.2` as `15`, and a patch release of a checked release unit is accepted. A target whose release unit is newer than `supported.to` is refused at ingest. An installed version whose release unit is older than `supported.from` gets a note, and the size can't be `none`. Pre-releases are refused at ingest as well as in composition.
- `pack.json` names its seeded repo (`seeded`), and the lint reads that repo's `ground_truth.json`.
- The display-text fields that may look like commands are `verify_hint` and `rollback_hint` in rules, and `checks_hint` in packs.

Why:

- Composition had to find "the version the primary's peer requirements demand", but no field held it. A rule's single `match` says *where* a requirement applies; `requires` says *what* it requires.
- Applying a conditional requirement even when its match finds nothing errs toward flagging (PRD section 3). Skipping it could hide a needed React upgrade behind a file the scan missed.
- Nothing said what happens when the target is newer than the pack has been checked for, which is the usual case right after a new major ships. Refusing is honest. Composing anyway would give a plan built on knowledge that nobody has written yet.
- Comparing raw versions would refuse almost every real target, because `supported` is written in release units and real targets carry a patch number (`5.2.7` is newer than `5.2`). Patch releases don't get their own release file, so the release unit is the right grain.
- INV-38 promised refusal at ingest, but no milestone touched ingest for it. M3 now does.
- The lint and the skills disagreed about where a pack's seeded repo lives (`eval/seeded/<pack>/` vs `next-tricky`). An explicit field removes the guess.
- A rollback hint such as "pin next@14 again" reads like a command. Without the exemption, the lint would reject honest rules.

### D14 - Fallback docs are recorded as `fetched_by: knowledge`

**Decision: when Context7 is unavailable and the engine falls back to the rules' `source` links and the generated references, each one is written to `run_docs` with `fetched_by: knowledge`, status `unverified` and a `doc_id`. In server-side mode the engine queries Context7 by a symbol from the rule's typed match, never by `doc_topics`.**

A rule's `source` link keeps its URL, and `official` is computed with the same URL check as any other doc. The M3 lint checks every `source` with that same check (one shared module, `src/docs/officialUrl.ts`), so a `source` the lint accepts always comes out `official`. A generated reference has no web URL, so it gets `pack://<pack>@<version>/references/<file>`, `official: false`, and the library and version of the release it describes. For both, the `doc_id` hashes the text the engine serves.

Why:

- `fetched_by` could only be `engine` or `agent`, and nothing said whether fallback links got a `doc_id`. Either INV-35 or gate 3 would have broken whenever Context7 was down, which is the case M4 exists to handle.
- They stay `unverified` even though the links are official. That is the same rule D9 applies everywhere: a URL proves where a doc claims to come from, not what it says.
- `doc_topics` are free-text search phrases. Sending them from the engine would break the "no free-text field" rule of C6, even though they come from reviewed knowledge rather than the repo.

The same review corrected two contradictions with D9 and D11 rather than deciding anything new. M4's risks section had required an allowlisted host for registered docs; D9 accepts any doc and labels it. M2 had checked the Next.js usage list through Context7; D11 checks it against the official sources. D9's claim that the server-side mode "vouches for content" was also narrowed: it removes the agent from the path, but the content is still Context7's.

### D15 - C9 covers knowledge; the "no core changes" check is an allowlist; the regression rule covers what shapes a plan

**Decision:**

- C9, INV-8, INV-10 and every list of places commands may never come from name both `knowledge/` and `packs/`.
- `scripts/check-core-untouched.ts` (M10) is an allowlist. A pack PR may change only its knowledge and pack folders, one new usage adapter and its registry line, eval data, tests, docs, and the outputs its build and eval regenerate (`plugin/**`, `eval/history/`, `eval/seeded/recall.md`, its entry in `eval/seeded/ratchet.json`). The drift check guards `plugin/**` and `recall.md`. The ratchet check refuses a change to an entry present on the base branch. A new entry must equal the recall the seeded tier measures, which is INV-50 (`npm run recall -- --check --base`), not `check-core-untouched` (that check must not import the scorer). Another pack's entry may not change. Under `eval/history/`, files may only be added, never changed or deleted.
- **Pack PR and core PR.** A *pack PR* is a PR that changes anything under `packs/` or `knowledge/`. A *core PR* is any other PR: one that changes nothing under `packs/` or `knowledge/`. These are the machine definitions, used by every check and document.
- **Eval data in a pack PR.** A case's pack is the `pack` field of its `case.json`. A pack PR may add new case folders for its own pack, and complete its own pack's cases that have no recorded runs on the base branch (such as the Django cases M0 committed with only `case.json`). Completing a case may add files and may change only `notes` and `checks` in `case.json`; the pinned fields (`id`, `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`, `source`, `target`, `tags`, `license`) stay byte-identical. The PR may add the recorded runs, engine and baseline, for those new or completed cases only, and may add (never edit or delete) a line for each new case in the coverage matrix in `eval/cases/README.md`. In `eval/cases/coverage-gaps.json`, a JSON array of per-pack pending/gap strings, every base entry that does not start with `<own-pack>:` must still be present at HEAD; the PR's own pack's entries may be added or removed, and either version that is not a JSON array of strings fails closed. A line count cannot express this: appending to the array edits the previous line's comma, and the Django PR has to remove its own "pending" entry. It may not add, complete or record runs for another pack's case.
- **Eval data is add-only on every PR.** An *existing case* is a case folder under `eval/cases/` with recorded runs on the base branch. On every PR, not only pack PRs, `scripts/check-eval-add-only.ts` (M7) fails when a file in an existing case's folder is added, changed or deleted, when the folder is deleted, when an existing recorded run is changed or deleted, or when a run is added to a set that already has runs on the base branch. A *set* is a case's engine runs under one prompt version (`eval/runs/<case>/<prompt_version>/<n>/`), its L1 set under that version (`eval/runs/<case>/<prompt_version>/l1/<n>/`, M8) or its baseline folder. Adding runs under a new prompt version, or a case's first L1 set under a version, is plain adding and needs no exception. L1 sets are their own sets: they don't count toward N or the pack gate's recall, and M8 replays them by re-scoring their `stage_attempts`. One narrow allowance is part of the rule: `annotations.json` in an existing case's folder may gain appended entries (or be added with its first entries), while its existing entries are frozen; headline metrics stay on raw truth (INV-30).
- **Pending cases.** A pending case (one with no recorded runs) may be removed only through exception (b), with a `REMOVED.json` entry, like any case. A pack PR may never remove one, nor change it except by completing it (its own pack's only), which leaves the pinned fields byte-identical.
- **The exceptions.** The only exceptions to the add-only rule, referenced from everywhere else, are:
  - (a) a core PR that changes `eval/baseline/prompt.md` may replace baseline runs, since baseline runs have no version folder. It must replace every pack's baseline runs and may replace nothing else: no engine run and no case file.
  - (b) a case may be removed, together with all its runs, only in a core PR reviewed by a maintainer. The PR adds an entry (`id`, `reason`, `pr`) to the committed `eval/cases/REMOVED.json`, which is add-only: the check requires the entry in a removal PR, fails an entry added with no matching case removal, refuses edits to or deletion of existing entries, and `results.md` renders the file. Deleting a single run without removing its case is never allowed. The maintainer review is enforced by GitHub's required code-owner review (`.github/CODEOWNERS` names a maintainer for `eval/cases/**` and `eval/runs/**`); CI does not try to check reviews. M7 turns on branch protection with "Require review from Code Owners". GitHub doesn't let an author approve their own PR, so a removal or baseline-prompt PR opened by a sole maintainer needs a second code owner; until there is one, that is a known limit. This is also the path for replacing a case whose pinned commits can no longer be fetched, and for a change to usage spans or the shared snippet normaliser: in the same core PR, the affected cases are removed and re-added under new IDs with freshly derived truth and new runs (D17).
- The regression rule also covers `src/analysis/` and the staging, packet and routing code, and it applies from M7.
- C8 reads "until v0.1 ships (M11) with real eval numbers", as PRD section 1 already says.

Why:

- Since D10, codemod IDs and every rule live in `knowledge/`. A constraint that only names packs no longer covers where the risk is.
- The old protected list missed `scripts/`, so a pack PR could have loosened the very lint and generator it is checked by. It also missed the risk, sizing, docs and CLI code. An allowlist can't miss a new folder.
- Sizing decides whether the lenses run at all, and the usage adapters and risk signals decide what is found and how it is rated. Changing them without rerunning the eval would let plan quality move unseen.
- C8 had two readings: "until eval numbers exist" (true from M7) and "until M11" (M10's README task). The PRD's wording settles it.
- The ESLint write and spawn rule is scoped to `src/`, because the maintainer tools in `scripts/` and the eval tooling under `eval/` legitimately write files and run `git` and `gh`. They stay outside the engine through the import lint, which stops anything under `src/` importing from `scripts/` or `eval/` (INV-40).
- Generated outputs have to change with the pack: the plugin bundle is drift-checked, and every eval rerun writes a history file. Leaving them off the allowlist would fail every honest pack PR.
- The pack gate scores every PR, so the recorded runs are evidence for every PR, not only pack PRs: a prompt or knowledge PR could otherwise edit the runs it is judged on. That is why the add-only check runs on every PR from M7, when recorded runs first exist, rather than only inside M10's pack allowlist. The two exceptions are the only legitimate reasons to replace or remove runs, and both are core PRs.
- Freezing the pinned fields of `case.json` keeps the commits and versions as M0 vetted them, so a pack PR can't move a case to an easier commit. `notes` and `checks` are what completing a case needs (exclusions for truth derivation, check commands for L1), so they may change until the case has runs.
- A removed case would otherwise vanish from `results.md` without a trace. Keeping the removals in an add-only file at HEAD lets `results.md` list them while staying a function of HEAD's tree.

## 2026-10-18: fixes from the review of the plan fixes

A second independent review (`b0f2fc2..plan-review-fixes`) found that D12 left gate 2 unmeetable outside `none` runs, and that the add-pack skill had loosened the baseline requirement. It also corrected D13 (release-unit comparison), D14 (generated references) and D15 (the allowlist's generated outputs, the import lint over `eval/`, and the C9 wording) in place, since those decisions had not been merged yet. A review of these fixes (`66d34ce..plan-review-fixes`) then tightened D16 (findings and engine reasons don't overlap; the gate 2 trade-off is stated), D17 (recall, the noise band and the CI check are defined) and D14 and D15 in place, for the same reason. A review of that round found the CI pack gate could still be passed or skipped: the recorded runs were missing from the allowlist, a PR's re-recorded runs set their own band, and the gate ran only on the regression-rule paths. D15, D16 (lens marks on usages with findings) and D17 were tightened in place again, and D14's lint now uses the same URL check as the `official` label. A further review tightened D15 (existing golden cases are add-only, and a pack PR completes its own pack's cases that have no runs yet), D16 (one lens can't both mark and cover a usage, and a scope exclusion outranks a finding on that usage) and D17 again: each pack's recall is pooled from each case's worst or best run, every case has the same number of runs on both sides under HEAD's prompts, a PR that widens a pack is checked on its base cases only, the beat check applies to every pack with no band yet and again when a pack is widened, replay re-runs HEAD's engine on the recorded lens submissions, and CI checks the run and case counts. A third review then tightened D15 and D17 in place again: it defined what a run records and how replay feeds it back, made the eval add-only check run on every PR with two named exceptions, and required one host product and model per pack, a fail-closed error for unfetchable case commits, and truth matched by file, span and `snippet_hash`. A fourth review tightened D15 and D17 again: it defined pack and core PRs, limited the baseline-prompt exception to baseline runs in a core PR, froze a pending case's pinned fields, added the add-only `eval/cases/REMOVED.json`, made `results.md` a pure function of HEAD's tree with base-dependent verdicts in the CI output, said how replay handles a recorded input HEAD rejects, and recorded two accepted limits. A fifth review tightened D15 and D17 once more: a truth-freezing change re-adds the affected cases under exception (b), L1 recordings are their own sets, `annotations.json` may gain appended entries, pending cases are removed only under exception (b), `tags` is pinned, `REMOVED.json` entries must match a removal and are never deleted, and the retired-model limit is restated.

### D16 - Lenses can mark usages out of scope; unmatched usages are covered in every run

**Decision:**

- `submit_findings` takes `out_of_scope[] {usage_id, reason}` alongside the findings. A lens may only name usage IDs from its own packet, and the reason must be non-empty. The usual case is code already in the target form (a seeded `no_change` entry).
- In every run size, the aggregator writes `no rule in range` for each usage that matches no composed rule and that no finding covers. This replaces D12's `none: no rule in range`, which only `none` runs got. A usage with a finding is in the plan, so it never also appears as out of scope through the engine.
- Every `out_of_scope` entry records `written_by`: `scope` (from `set_scope`), `engine` (`no rule in range`) or the lens. A usage keeps one entry. When more than one applies, `scope` wins, then `engine`, then a lens, and the others are recorded as events.
- A finding outranks a lens's mark. If one lens marks a usage out of scope and another covers it with a finding, the usage is in the plan with no lens entry, and the mark is recorded as a conflict event, like a severity conflict.
- An invalid `out_of_scope` entry counts as invalid output under the lens retry policy, like an invalid finding. So does a submission in which the same lens both marks a usage out of scope and writes a finding on it: `submit_findings` rejects the whole submission rather than choosing one, stores no item from it, and counts it toward the retry policy. If the lens then ends in `lens.gap`, the usages it would have covered stay uncovered unless another lens's finding or an out-of-scope entry covers them, and gate 2 sends them to `unresolved`.
- Scope-excluded usages are left out of lens packets. If a finding still covers one, the `scope` entry stands: the usage is removed from the finding's coverage and recorded as a conflict event, and the finding stays in the plan for its other usages. Only a finding left covering no usage is kept out of the plan, and the run report lists it.
- A lens-written entry on a usage whose rule has `necessity: breaks` goes to "Review first", like a scope exclusion (INV-34).
- The run report and the eval split out-of-scope counts by `written_by`.

Why:

- Gate 2 needs every usage covered by a finding or an out-of-scope reason, but lenses could only submit findings. Code already in the target form, which M2 seeds on purpose as `no_change` ("found, then marked out of scope"), could not be covered in `small` or `full` runs. Gate 2 would fail three rounds and push it into `unresolved` on every such run, and `next-tricky` sizes as `full`.
- Matches are syntactic: an awaited `cookies()` still matches `call {next/headers, cookies}`. Only a lens reading the code can tell that a matched usage needs no change. D12's example ("code already in the target form") was wrong for `none` runs and is corrected there.
- No rule in range concerns a usage that matches no composed rule, so the engine covers it in every run, as D12 already did for `none`. This is a trade-off, accepted on purpose: gate 2 no longer makes a lens look at such usages in `small` and `full` runs, so a change the knowledge is missing can pass unseen. The alternative, making every lens mark every unmatched usage, costs packet space on code that is usually just an ordinary import. The lenses still see these usages in their packets (unless a packet is truncated, which the packet reports) and can write findings on them, the counts are split by `written_by`, and M7's recall against real PRs measures what the knowledge misses.
- A lens marking a breaking usage out of scope carries the same risk as a scope exclusion: dropping work to pass a gate. Routing it to "Review first" and splitting the counts keeps it visible, and M7's recall against real PRs measures it.
- Two lenses can disagree, and a finding outranking a mark settles that. One lens marking and covering the same usage contradicts itself, and storing part of the submission would mean choosing for it, so the whole submission goes back for a retry like any other invalid output.
- The scope is the user's answer, and a lens can't widen it (INV-33). Letting a finding pull an excluded usage back into the plan would widen it through the lens, so the finding gives way on that usage. Its other usages still need the work it describes, so it keeps them; the conflict event, and the run report for a finding with nothing left, keep it visible.

### D17 - A pack PR must beat the baseline on recall

**Decision: a new pack's eval must beat the no-engine baseline on recall before the pack merges, and existing packs must not regress beyond the recorded noise band. This applies to the Django pack in M10. A pack that misses is not ready; the contributor raises it with the maintainer instead of tuning the eval or the baseline.**

- **Recall** means M7's usage recall on the pack's golden cases, the one metric the engine and the baseline are both scored on. It is pooled over the pack's cases: true changed usages covered, over all true changed usages.
- **What a run records.** Every engine run, whatever its size, records the ingest arguments, the `set_scope` answers, every `run_docs` entry whatever its `fetched_by` (`agent`, `engine` or `knowledge`), with URL, content, `doc_id`, `fetched_by`, `official` and status, and each `validate_plan` round's lens submissions in order, including any retry attempts within a round, with the file, span and `snippet_hash` of every usage ID its packets carried. It also records the transcript, the cost and wall time, and the host product and model. A baseline run records its Markdown plan, the hash of `eval/baseline/prompt.md`, and the host product and model.
- **Replay re-runs the engine.** Replay rebuilds each engine run on HEAD's deterministic engine: it applies the recorded ingest arguments and scope answers, re-registers every recorded doc itself with no network (no Context7), and feeds the recorded rounds' lens submissions in order through `find_usages`, the packets (to match usage IDs and snippet hashes), `merge_findings` and the gates, with no new agent turns. Replay stops at the first round HEAD's gates pass, as the live flow does, and scores that plan; later recorded rounds are not fed. A failure that HEAD's gates newly raise, with no recorded round left, goes to `unresolved` and is scored, never patched. Replay keeps each recorded run's size and lens set and does not re-run sizing; if HEAD would size the case differently, the report flags the run, and new live runs measure the change. It scores the result and never calls a model, so knowledge and engine changes show up without new runs. A recorded usage ID is matched to HEAD's usage by its recorded file, span and `snippet_hash`, so renumbered IDs change nothing; the run's recorded `repo_id` (the one value its findings share, a hash of the recording machine's checkout path) is replaced with HEAD's on findings and evidence, any other value is left for HEAD to reject, and a run whose findings name more than one fails loudly (2026-10-31: without the swap every engine submission was rejected anywhere but the maintainer's machine, and CI re-scored the engine at 0/86); a recorded finding with no matching HEAD usage is dropped and counts as a miss, and the report lists those. Truth usages are matched the same way, and `truth.json` is never re-derived for an existing case. Baseline runs are re-scored from their recorded Markdown, since there is no engine to re-run.
- **When HEAD rejects a recorded input.** Replay handles it as the live flow would and flags the run. A recorded scope answer HEAD no longer offers takes the default. A recorded submission that HEAD's `submit_findings` rejects counts as that lens's invalid output under the retry policy, using the recorded retry attempts if there are any, and then `lens.gap`. A recorded doc that HEAD's version pin refuses is not registered.
- **`results.md` is a pure function of HEAD's tree.** It holds no generation time, takes cost and wall time from the recorded runs, and records the engine by its package version, so the same tree always gives the same bytes. It always reports each pack's beat result over all its cases, which needs only HEAD, and renders `eval/cases/REMOVED.json` (D15). Verdicts that depend on the base branch (the regression check's pass or fail, a skipped regression check, the enforced or reported widening beat result) go in the CI job output, never in `results.md`.
- **Case commits.** Eval tooling fetches each case's pinned commits, outside the engine, and CI caches them. When a pinned commit can't be fetched and isn't cached, the gate fails closed with a named error (`case_commit_unavailable`), never skipping the case. The remedy is `npm run cases:verify` and replacing the case through the case-removal path (D15, exception b). *How (2026-10-31, found when main's CI first reached the eval steps):* `npm run cases:fetch` (`eval/caseCommits.ts`) does a depth-1, no-tags fetch of each pinned base commit into `eval/.work/<id>` and a detached checkout, for every case with truth and a recorded run; a checkout already at the base is left alone and a dirty one is never reset. The case schema allows only `https://github.com/<owner>/<repo>` and full 40-hex SHAs, and the fetch re-checks both before git runs, passes `--` before the URL and turns hooks off, so case data from a pack PR can never be read as a git option (review round 1: an option-shaped `repo_url` ran a command through `--upload-pack`). A dirty checkout (`case_checkout_dirty`), a refused record (`case_record_invalid`) and a commit missing upstream (`case_commit_unavailable`) each print their own remedy. A `case.json` that is not JSON or fails the schema also prints `case_record_invalid`, naming the case folder, before any case is fetched (D59). After the add-only and "No core changes" steps (D59), CI caches `eval/.work` keyed on the hash of the `case.json` files, then runs the fetch and then the smoke, so a cache miss refetches and an unfetchable commit fails the step. Replay uses a checkout only when its HEAD is the pinned base and its tree is clean, and `generate()` throws `case_commit_unavailable` before rendering, so neither `--check` nor a regeneration can turn a missing checkout into "No recorded golden runs yet". Before this, M7's runner used whatever `eval/.work/<id>` held and never fetched, so `results.md` could only be reproduced on the maintainer's machine. Alternatives: a full clone (hundreds of MB per case, history replay never reads); fetching inside `npm run eval` (keeps a network step inside a command the docs call free and offline). Revisit if a case host refuses fetch-by-SHA.
- **Which runs count.** The gate and `results.md` use only engine runs under the current prompt version that `prompts/manifest.json` names at HEAD. L1 sets (`eval/runs/<case>/<prompt_version>/l1/<n>/`, M8) are separate and never count toward N or the pack gate's recall. A new prompt version therefore needs N new engine runs for every case of every pack before the gate can score it, and adding them is a core PR (one that changes nothing under `packs/` or `knowledge/`, D15). Each baseline run records a hash of `eval/baseline/prompt.md`, and all baseline runs of a pack must share HEAD's hash; a baseline run with another hash fails the gate. Changing `eval/baseline/prompt.md` is a core PR that must replace every pack's baseline runs (D15, exception a).
- **Run counts are equal.** Every golden case of a pack has the same number N of these engine runs, and the same N of baseline runs, with N at least 3. All of them, on both sides, are made with the same host agent: the same host product and model, as each run records. The host's CLI version may differ.
- **Worst and best case.** The engine's figure for a pack is its *worst-case pooled recall*: for each case take that case's lowest-recall engine run, then pool over the pack's cases. The baseline's figure is its *best-case pooled recall*: each case's highest-recall baseline run, pooled the same way. Neither depends on how the runs are numbered.
- **The noise band** for a pack and side runs from the pooled recall of each case's worst run to the pooled recall of each case's best run. M7 records it in `eval/results.md`, with each case's covered and true changed usages for its worst and best run, so the band can be recomputed over any set of the pack's cases.
- **Which packs are checked.** The gate checks only packs that exist under `packs/` at HEAD. A case whose pack doesn't exist yet, such as the Django cases M0 committed with only `case.json`, is listed as pending in `results.md`, not failed. A pack at HEAD needs at least 2 golden cases and at least one true changed usage across them.
- **Beating the baseline** means the engine's worst-case pooled recall is above the baseline's best-case pooled recall. It is required of every pack at HEAD that has no band in `eval/results.md` on the base branch, whichever PR adds its cases. It is required again, over all the pack's cases including the new ones, of a PR that widens a pack that was beat-checked when it was added. The first pack, `nextjs-upgrade`, sets the first band in M7 and is exempt: the beat check applies from the Django pack (M10), and M7's `results.md` states plainly where the engine does not beat the baseline. When `nextjs-upgrade` is widened, its beat result over all its cases is shown (`results.md` always shows it) but not enforced.
- **A regression** means the PR's engine worst-case pooled recall, over the cases in the base branch's band that are also present at HEAD, falls below the low end of the base band recomputed over the same cases. The band is the one in `eval/results.md` on the base branch; the PR's own regenerated band is never the reference, since it is computed from the runs being checked. When the base branch has no band for a pack, the regression check is skipped for it and the CI job output says so.
- **Widening a pack.** Golden cases a PR adds to an existing pack are not in the base band, so the regression check leaves them out. The beat check, where it applies, counts them: over all the pack's cases, the engine's worst-case pooled recall must still be above the baseline's best-case pooled recall. The new cases must have the same N as the pack's existing cases. Their runs join the pack's band in the PR's regenerated `results.md`, which becomes the base for later PRs.
- **It is checked in code.** On every PR, not only on the regression-rule paths, CI replays the recorded runs. Replay calls no model and no paid service (C1). The pinned case commits are fetched by eval tooling, outside the engine, and CI caches them; C6 covers only the engine's own network, so it is unaffected. For each pack at HEAD, it fails the PR when:
  - the pack has no band on the base branch and doesn't beat the baseline (except `nextjs-upgrade`)
  - the PR widens a pack that was beat-checked when added, and over all its cases the pack doesn't beat the baseline
  - the pack's engine worst-case pooled recall falls below its base band
  - the pack has fewer than 2 golden cases, or no true changed usage across them
  - any case has fewer than 3 runs on either side, or the run counts differ across the pack's cases or between the engine and the baseline
  - a baseline run's prompt hash differs from HEAD's
  - the pack's runs, engine or baseline, don't all share one host product and model
  - a pinned case commit can't be fetched and isn't cached (`case_commit_unavailable`)

  It also fails a PR whose committed `eval/results.md` differs from the re-scored one, so the numbers can't be hand-edited. Because `results.md` is a pure function of HEAD's tree, the same tree always gives the same bytes, also on the commit after a case removal.
- **Accepted limits.**
  - `truth.json` is frozen for an existing case, so a change to usage spans or to the shared snippet normaliser reads as misses on existing cases and fails the regression check on them. Such a change goes through D15's exception (b): in the same core PR, the affected cases are removed (with `REMOVED.json` entries) and re-added under new IDs with freshly derived truth and new runs. The re-added cases count as new cases of their pack: they are outside the regression check's base cases, and the beat check over all cases applies as for widening.
  - Once a pack's recorded host model is retired, new engine runs can't share the baseline runs' model, so no new prompt version can be scored for that pack and it can't be widened. The only route today is a baseline-prompt change under D15's exception (a), which replaces the baseline runs of every pack. The path is to be decided with M7 data; there is no exception for it.
- **Recorded runs and cases are evidence.** On every PR, `scripts/check-eval-add-only.ts` keeps existing cases and recorded runs add-only, with D15's two exceptions (a core PR that changes the baseline prompt replaces only baseline runs; a case removed with all its runs in a core PR, recorded in `eval/cases/REMOVED.json`). A pack PR may add new cases, and complete its own pack's cases that have no recorded runs on the base branch, with their runs (D15).

Why:

- PRD section 14 already says a pack PR must "pass the eval against the baseline". The add-pack skill had been changed to say only that a miss should be reported, which would have loosened a gate without a decision.
- The baseline is what a user gets from their own agent. A pack that doesn't beat it adds maintenance with no measured value.
- The host agent varies between runs, so a single run can beat the baseline by luck. Comparing each case's worst engine run with each case's best baseline run keeps the claim honest at the cost of being strict. The run count and the comparison are starting values, to be revisited with M7 data.
- An earlier draft pooled run *k* of every case. That result depends on which run is numbered *k*, so renumbering the runs could move it. Taking each case's worst or best run gives the same figure whatever the numbering, and it is never kinder to the engine than any run *k*.
- With unequal run counts, a case with more runs has more chances of an extreme run, so the worst and best cases would not be comparable across cases or between the sides. CI checks the counts, because a reviewer could miss them.
- A new golden case can be harder than the existing ones. Pooling it into the regression check would read as a drop although nothing changed on the existing cases, so the base cases alone decide whether the engine regressed. The claim that a pack beats the baseline is about all its cases, though, so widening re-runs the beat check over all of them.
- Re-scoring only the recorded findings would leave the numbers unchanged when the knowledge or the engine changes, so the regression rule could be met without measuring anything. Replaying the lens submissions through HEAD's engine measures the change without paying for new runs, and a recorded finding that HEAD no longer accepts counts against the engine rather than being scored as if it still matched.
- A beat check tied to the PR that creates `packs/<pack>/` could be dodged by adding the pack with no cases and the cases in a later PR. Tying it to "no band on the base branch", with at least 2 cases and some true changed usage, closes that gap.
- The first pack has no earlier band and no earlier pack to compare with: M7 is where the engine is first measured. Blocking M7 on the beat check would leave the eval unbuilt, so M7 reports plainly where the engine loses instead.
- The Django cases were committed in M0, before the Django pack exists. Failing them would fail every PR until M10, so they are listed as pending, and the Django pack PR completes them.
- Runs under an older prompt version, or a baseline given a different prompt, measure something else. Scoring only HEAD's prompt version and HEAD's baseline prompt keeps the two sides comparable.
- A gate that only a reviewer checks can be skipped or misread. Replay is free (C1): it calls no model and no paid service, and the case commits it needs are cached in CI. So CI can check it on every PR, including one that touches only `eval/`.
- The gate scores whatever runs are committed. Comparing with the base branch's band, and keeping existing cases and runs add-only on every PR, not only pack PRs, stops any PR from moving the bar by re-recording or editing the runs it is judged on.
- A replay that asked the agent for new turns, or patched a newly raised gate failure, would no longer be replaying the recorded run. Recording every input, and sending what HEAD newly rejects to `unresolved`, keeps replay a measurement of HEAD on fixed agent output.
- Failing closed on an unfetchable commit stops a case from silently dropping out of the pool, which could lift a pack's figure.
- A `results.md` that held base-branch verdicts would change when the base moves, so regenerating it on HEAD could not reproduce the committed bytes. Keeping it a function of HEAD's tree, and putting base-dependent verdicts in the CI job output, keeps the hand-edit check exact.
- A recorded input HEAD rejects is the same situation a live run would be in, so replay follows the live flow rather than dropping the run, and the flag keeps it visible.

## 2026-10-19: Node floor and the per-milestone review

Decisions from the pre-M1 comprehension check, which also added three M1 test details (`scan-walk-refusals`, the MCP case of `out-inside-repo-refused`, and the repo layout in `write-outside-out-dir`).

### D18 - Node 22.13 is the minimum

**Decision: `package.json` sets `engines.node` to `>=22.13`, and `node:sqlite` is the SQLite driver. `better-sqlite3` stays the overview's fallback but is not added.**

Why:

- The floor applies to the machine that runs the engine, not to the project being migrated. The engine reads the repo's files and never runs its Node at L0, so a project pinned to an older Node can still be scanned.
- `node:sqlite` runs without the `--experimental-sqlite` flag from Node 22.13. A lower floor would need `better-sqlite3`, a native module with the install friction the overview chose the built-in driver to avoid.
- Node 18 and Node 20 are past end of life (April 2025 and April 2026), so 22 is the oldest supported LTS line. A user whose project needs an older Node can run the engine through a version manager without changing the project.
- `node:sqlite` still prints an experimental warning on 22.x. It goes to stderr, so INV-14 holds.
- Revisit only if the Node prerequisite is reported as a real blocker. A standalone executable that bundles Node is the cheapest option and is a packaging choice, not an engine change.

### D19 - The reviewer's summary replaces the quiz as gate 6

**Decision: gate 6 is a plain-language summary the reviewer writes for the user, not a quiz. The reviewer removes each guard the milestone adds and confirms a test fails, sorts findings into "must fix" and "noticed", and takes at most 2 rounds. The builder stops and asks the user when a fix fails the same gate or test twice in a row. `quiz-me` stays, optional.**

Why:

- The maintainer oversees the build and does not write the code. A quiz on code tests code reading, which is not the maintainer's job, and it slowed every milestone.
- The pre-M1 quiz found real gaps, all of one kind: a guard that could be removed, or never reached, with no test failing. Running the mutation check on every guard catches that kind directly, and a reviewer can run it.
- Uncapped rounds can loop, as the plan reviews showed (hence the 3-round cap in `plan-review.md`). Code reviews get a 2-round cap, and only "must fix" blocks; "noticed" items go on the user's list, as AGENTS.md rule 1 already does for the builder.
- Rule 3 (never weaken a gate) still holds for tests, constraints and thresholds. This is the maintainer's decision on a process gate, and the mutation check gets stricter: every new guard instead of at least one.

## 2026-10-19: M1 build decisions

Choices M1 made where the plan left a question open. D20 records the three the maintainer decided before the build; D21 and D22 record the builder's smaller ones.

### D20 - Ingest: what "known" means, dirty state, and where output goes by default

**Decision:**

- **A known library is one declared in the repo's manifests** (`package.json`, `pyproject.toml`, `requirements*.txt`; Python names compared after PEP 503 normalisation). An unknown source or target gets a `vague_input` question. M3 adds the pack check on top; until then there is no library list in core code.
- **The installed version comes from lockfiles only.** No lockfile pin gives an `unresolved_version` question, lockfiles or workspace packages that disagree give `ambiguous_version` with every candidate, and a user-given source version that disagrees with the lockfile gives `version_mismatch`. A given version matches when each of its parts equals the lockfile's, so `14` and `14.2` match `14.2.35`.
- **Dirty state is always `unknown` in v0.1.** HEAD and refs are read as files, and git is never run.
- **The default `--out` is `.migration-planner/` beside the repo** (`<repo's parent>/.migration-planner/`), never inside it. *Revised by D24:* beside the top of the outermost git repo that contains the scanned folder. The MCP server, which learns the repo only at ingest, uses the same default per repo.

Why:

- A built-in list of libraries would put pack data in core code for one milestone. "Declared in the repo" needs no data, and it is a check the agent can't satisfy by guessing.
- A real dirty check would mean hashing every tracked file, including any tracked `.env`, which the deny list forbids, and parsing `.gitignore` for untracked files. Reporting `unknown` is honest and costs nothing. Revisit if a later milestone needs the answer.
- Beside the repo is easy to find and matches the PRD's example; runs from several repos in one parent folder share a store, keyed by repo ID. The user's cache folder was the alternative: never near code, but it hides the plan from the user.

### D21 - Tooling pins for M1

**Decision:** TypeScript 6.0.3, not 7. `@modelcontextprotocol/server` 2.3.1 (the stable v2 line), with `@modelcontextprotocol/client` 2.3.1 for tests. ESLint 10 with a flat `eslint.config.js` instead of the plan's `.eslintrc.*`. `yaml` and `smol-toml` (pure JS) parse pnpm lockfiles and TOML.

Why:

- TypeScript 7 is the native port; its JS API is published under `unstable/*`, and M2 needs the stable compiler API. typescript-eslint supports TypeScript below 6.1.
- ESLint 9 dropped `.eslintrc`, so the flat config is the only current form. The rule itself is as planned.
- Lockfile and `pyproject.toml` formats need real YAML and TOML parsers. Both packages are pure JS, so there is no native build (C3's spirit, D2).
- Revisit TypeScript at M2 if TypeScript 7 stabilises its API.

### D22 - Smaller M1 choices

- **Walk refusals are skipped and listed; direct reads throw** (the plan's "decision to record"). During the `scan_repo` walk, an entry that `resolveInside` rejects or the deny list matches is listed in `skipped` with `outside_root` or `denied` (path only) and the walk carries on. A deny-listed folder (`node_modules/`, `.git/`, `.venv/`) is listed once, not walked. A path passed directly to a read API throws `PermissionError`, which the tool wrapper records as `tool.error`.
- **`--db` gets the same refusal as `--out`.** Both are checked before anything is created, so a refused flag leaves no file in the repo.
- **`resolveInside` also rejects a relative path whose `..` climbs above the root and comes back** (`../repo/x`), and an absolute path outside the root that a symlink leads back in. The deny list checks both the requested name and where it really points.
- **Events before a run have no run ID.** A question or a refusal after the store opens is still recorded, with `run_id` null. A refusal before the store opens (multi-repo, `--out` inside the repo) is returned but can't be recorded: there is nowhere safe to write it.
- **The idempotency key uses `none` for the pack and prompt versions** until M3 and M5 add them. Re-ingesting returns the existing run with its campaign, even if a different `campaign_id` is passed; the key does not include the campaign, as the plan specifies.
- **`scan_repo` re-scans on every call** and replaces the run's `files` rows, since the dirty state is unknown and the files may have changed under the same HEAD. Each scan appends a `scan.result` event.
- **The tool output is one object with a `status`** (`ok` or `question`) rather than a union, because the SDK wants an object root for `outputSchema`.
- **Unparseable manifests are reported in `manifest_errors`**, never dropped. `setup.py`, `setup.cfg` and `Pipfile` are reported as unrecognised manifests, except a `setup.py` inside a Python package (an `__init__.py` beside it), which is a module such as a Django command.
- **Next.js `app/` and `pages/` count as entrypoints only in a package that uses Next.js** (a `next` dependency or a `next.config.*`), so a docs folder named `pages/` isn't mislabelled.
- **CLI exit codes:** 0 ok, 1 bad input or error, 2 refused (`PermissionError`, not built), 3 a question to answer.

### Host wiring (M1 task 10)

The CLI and the MCP server are one binary. Until the npm publish (M11), run it from a checkout after `npm install && npm run build`; afterwards `npx migration-planner-mcp` replaces `node <checkout>/dist/cli/index.js`.

CLI:

```sh
node <checkout>/dist/cli/index.js scan <repo> --source next --target next@15.1.0
node <checkout>/dist/cli/index.js scan <repo> --source django --target django==4.2.30 --format text --out /tmp/mp
```

Claude Code:

```sh
claude mcp add migration-planner -- node <checkout>/dist/cli/index.js mcp
```

Cursor (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "migration-planner": {
      "command": "node",
      "args": ["<checkout>/dist/cli/index.js", "mcp"]
    }
  }
}
```

Add `"--out", "<dir>"` to the arguments to keep every run's output in one folder; without it, output goes to `.migration-planner/` beside each repo. The server logs its banner and output folder to stderr; stdout is the protocol channel.

## 2026-10-19: maintenance

### D23 - CI on every change, weekly dependency PRs, and the scanner split in M2

**Decision:**

- **CI** (`.github/workflows/ci.yml`) runs typecheck, lint, the full test suite (permissions included), the build, `check-spine.sh` and `check-agent-skills.sh` on every push to `main` and every PR. It runs on Linux at the Node floor (22.13.0) and latest 22, and on macOS. Windows runs too but doesn't block: the tests create symlinks, which need extra privileges there, and Windows hasn't been verified. Actions are pinned to commit SHAs, and the workflow can only read the repo.
- **Dependabot** (`.github/dependabot.yml`) opens weekly PRs for npm and the CI actions, grouping minor and patch updates. It skips TypeScript 6.1 and later (D21) and `@types/node` majors (which follow the Node 22 floor, D18). An update merges only when CI passes. An MCP SDK bump also needs its changelog read, as the overview asks at each milestone.
- **The scanner is split in M2** (task 15 in its plan), with no change in behaviour, before more code lands in `src/analysis/`.

Why:

- Before this, the gates ran only when someone ran them by hand. The permissions suite is the project's main safety control; it should fail a PR on its own.
- Exact pins are reproducible but go stale without anyone noticing, including security fixes. Weekly PRs that must pass CI keep them current without loosening them.
- The M1 plan named a Linux, macOS and Windows matrix as the mitigation for symlink and case-sensitivity edge cases. Linux and macOS are verified; Windows is reported until someone makes it pass, at which point it should block.
- `scanner.ts` is about 550 lines and three milestones add to it. Splitting it now is a mechanical change that the M1 tests check; later it would be tangled with new behaviour.

Revisit: make Windows blocking once it passes; add CI checks from later milestones (the pack lint in M3, the eval gates in M7) to the same workflow.

## 2026-10-19: fixes from the M1 review

### D24 - The default output folder stays out of an enclosing git repo too

**Decision (revises D20's default `--out`):** the engine finds the top of the outermost git working tree that contains the scanned folder (the highest folder holding a `.git` folder or file; only its existence is checked, nothing is read). The default `--out` is `.migration-planner/` beside that top, or beside the scanned folder when it is in no git repo. That top is registered like the scanned folder, so an explicit `--out` or `--db` inside it is refused as well. The maintainer chose that last point, on the reviewer's recommendation; the plan only named the scanned folder.

Why:

- The M1 review found that scanning a package inside a monorepo (`mono/packages/web`) put the store in `mono/packages/.migration-planner/`, inside the user's repo (C3), while the log said "outside the repo".
- Outermost, not nearest: a submodule (a `.git` file) or a repo cloned inside another repo's tree sits inside the outer working tree, so "beside the nearest repo" would still write into the outer one.
- An explicit `--out` inside the monorepo writes into the user's repo just as the default would, so the same rule applies.

Accepted limit: if the user's home folder is itself a git repo (a dotfiles setup), the top is the home folder, so the default lands beside it and any `--out` under the home folder is refused. The fix is an `--out` elsewhere (for example under `/tmp`). Revisit if this is reported.


## 2026-10-19: M2 build decisions

### D25 - The single read point and its allowlist

**Decision:** within `src/`, only `src/security/` may import a `node:fs` read API (`readFile*`, `readdir*`, `opendir*`, `stat*`, `lstat*`, `statfs*`, `realpath*`, `exists*`, `access*`, `createReadStream`, `openAsBlob`, `read*`, `readv*`, `glob*`, `watch*`; `open*` and namespace or default imports were already refused as writes). The allowlist outside it is exactly two reads of the engine's own files:

| File | Names | Reads |
| --- | --- | --- |
| `src/store/db.ts` | `readdirSync`, `readFileSync` | the SQL migrations under `src/store/migrations/` |
| `src/core/engine.ts` | `readFileSync` | the package's own `package.json`, for the version |

Nothing under `src/` may use `ts.sys` (a named `sys` import from `typescript`, or `ts.sys`), because it reads files directly; the TS adapter's `CompilerHost` reads through `safeRead`. The ESLint rule and `test/permissions/single-read-point.test.ts` enforce both.

Why:

- M1 checked INV-4 with tests but not with the lint, so nothing stopped new code reading a repo path directly, and M2's parsers are where that would happen.
- `src/pipeline/ingest.ts` realpathed and stat'ed the repo folder itself. That moved to `resolveRepoRoot` in `src/security/pathBoundary.ts`, with the same messages, so the allowlist stays at the two engine-file reads.
- The planted-lint test in `single-write-point.test.ts` that allowed reads anywhere now plants its read in `src/security/`, since reads elsewhere are refused.
- Libraries that read their own package files (web-tree-sitter loading its WASM) are outside `src/` and outside the rule; they never get a repo path.

### D26 - The Python grammar is vendored; TypeScript stays on 6.0

**Decision (maintainer's choice):** the tree-sitter Python grammar is committed as a prebuilt `.wasm` (`src/lang/python/grammar/`, from `tree-sitter-python` 0.25.0, MIT) with its version and sha256 in a README; `test/unit/lang/python.test.ts` checks the checksum. It is loaded by `web-tree-sitter` 0.27.1. TypeScript stays at 6.0.3 and moves to runtime `dependencies`.

Why:

- The `tree-sitter-python` npm package runs `node-gyp-build` on install for a native binding the engine never uses. Depending on it would put an install script and a possible native build on every user's machine, which C3's spirit and D2 ruled out.
- TypeScript 7.0.2 is released, but its compiler API is still published only under `unstable/*` (D21's revisit point). M2 needs the stable compiler API.

Cost: grammar upgrades are a manual copy (the README says how), not a Dependabot PR. Revisit when TypeScript 7 publishes a stable API, or if a grammar package ships the `.wasm` without an install step.

### D27 - The Next.js usage list, checked against the official guides

**Decision:** the Next.js adapter's targets were checked on 2026-10-19 against nextjs.org's version-15 and version-16 upgrade guides and react.dev's React 19 upgrade guide (primary sources, D11), and the plan's draft list was extended to match. The checked list is in `docs/plans/02-language-adapters-find-usages.md` task 8. A usage carries the plan's fields plus `module`, `match_kind` (the M3 match kind it can satisfy) and `labels` (`indirect`, `type_only`, `awaited`, `peer_conflict`, `optional_peer`, `passed_to_client`, `cache_option`).

- **Peer conflicts (maintainer's choice):** every peer range on `next`, `react` and `react-dom` in npm, pnpm and yarn berry lockfiles is a `peer_dependency` usage; it is labelled `peer_conflict` when the range excludes a known target. In M2 the only known target is the run's own (`next`); M3 passes the companion targets it composes (React) into the same `targets` map. A yarn v1 lockfile records no peer ranges, so the summary lists it in `peer_data_unavailable`.
- **Wrappers are followed only where callers must change:** a helper around `cookies()`, `headers()` or `draftMode()` makes its callers usages, transitively (they must await it once it is async). Wrappers around `fetch`, `revalidateTag` or the React removals are not followed: the change is at the call inside the wrapper.
- **Seeded repo versions (maintainer's choice):** `next-tricky` is a Next.js 14.2 / React 18 app, two majors behind 16.4, so its cases cover both the 15 and 16 changes.

Why: a draft from memory would miss the Next.js 16 removals (AMP, runtime config, `next lint`, the `middleware` rename) and the React 19 type changes. Revisit when a new Next.js major ships: the list and `next-tricky` change together.

### D28 - Smaller M2 choices

- **Parsing:** each TS/JS file is parsed in its own Program (`noResolve`, `noLib`), so the checker scopes names inside the file and the facts depend only on the file's content. That makes them cacheable by sha256 (`file_facts`, keyed by adapter, version and script kind). Cross-file resolution is done on the facts (`src/lang/graph.ts`). A per-file Program measured 3.4 ms per file, the same as one batched Program. Imports resolve with the package's tsconfig (`paths`, `baseUrl`, `moduleResolution`; Bundler when unset) through a host that sees only walked files; a workspace package imported by name resolves to its folder, since its `node_modules` link is deny-listed.
- **The language interface returns resolutions separately:** `imports(tree)` returns imports as written and `resolver(ctx)` turns them into edges, because resolution needs the whole repo and must not be cached per file. A Python from-import that binds a submodule (`from . import views`) gets an edge to that file too.
- **Syntax errors:** the file is listed in `unparsed_files` with `partial: true`, and the facts the parser recovered are kept. Both parsers recover, so dropping the facts would lower recall without making anything safer, and listing the file still keeps M3's size from being `none`.
- **Python string refs:** dotted strings of identifiers are heuristic `string_ref` edges; one trailing name is stripped to find the module (`app.middleware.Auth` -> `app/middleware.py`). Strings ending in a file extension or a common host suffix (`base.html`, `example.com`) are skipped.
- **Build output** (`.next/`, `.vercel/`, `.turbo/`) is not analysed and is listed in `skipped_generated`; generated chunks would bury the real usages.
- **Selecting the adapter:** until M3's `pack.json` names `usage_adapter`, the adapter comes from the run's source library (`next` -> `nextjs`). A library with no pack yet (Django until M10) gets the graph-only adapter: the import graph and symbols are stored and no usages are reported.
- **Pagination:** a `find_usages` call without a cursor recomputes the index (unchanged files come from the cache) and stores it under a new generation; a cursor pages through that generation and is refused once stale or used with other filters. The result always gives the total and says when it is one page of several. The CLI keeps no state, so `usages` ingests first (idempotent) and returns the first page.
- **Usage IDs:** the plan's hash of repo, file, start line, kind and symbol. Two usages with the same kind and symbol on one line are one usage, with their labels merged.
- **Recall matching:** a usage matches a ground-truth entry when its file and kind are equal and its lines include the entry's line. CI checks the ratchet against the PR base (or the previous push) with `npm run recall -- --check --base`, and `npm test` checks the floor and that `recall.md` is current.
- **Files outside the plan's list:** `src/schema/usage.ts` (the Zod schemas), `src/lang/index.ts` (the language registry), `src/lang/graph.ts`, `src/analysis/usages/trace.ts`, `parsePeerRanges` in `src/analysis/manifests/node.ts`, `resolveRepoRoot` in `src/security/pathBoundary.ts` (D25), and the test helpers `test/usages.ts` and `test/permissions/parser-boundary.test.ts`.
- **Acceptance runs on real repos (M2 review, 2026-10-19).** `find_usages` was run on two pinned golden-case checkouts, in a temp folder outside the engine; each repo's hash was identical before and after. **Next.js** — `neotree/neotree-editor` at `1f15f5c1` (next 14.2.35): 838 code files (813 parsed, 25 cached) plus 60 text-only, 607 usages, 1.53 s engine time, 0 unparsed, 0 unresolved; `yarn.lock` listed in `peer_data_unavailable` (the yarn-v1 case, D27). **Python/Django** — `thunderstore-io/Thunderstore` at `43873ef2`: the graph-only `none@1` adapter (no Django usage adapter until M10), 918 Python files, 1.11 s, 0 usages, 0 unparsed, 6 unresolved dynamic imports all listed; the import graph is real (4538 edges, 1810 resolved to repo files, 705 `string_ref` edges, 3050 symbols), all within the M1 size limits. Both satisfy the plan's acceptance criteria.

## 2026-10-19: M3 decisions before the build

### D29 - The Next.js pack's range, rules older than the range, who reviews rules, and usage-finder gaps

**Decision (the maintainer's four choices):**

- **Supported range: Next.js 14 to 16.** On 2026-10-19 the latest releases are `next` 16.4.2 and `react` 19.3.1. `knowledge/npm/next/` is complete from 14 (`covered_from: 14`), with release files for 14, 15 and 16, and `packs/nextjs-upgrade/pack.json` has `supported {from: 14, to: 16}`. React's knowledge is complete from 18, with release files for 18 and 19. Next 16's peer range still accepts React 18 (`^18.2.0 || ^19.0.0`), so "needs React 19" is a conditional `peer_requirement` tied to the app router (D13).
- **A rule whose first event is older than `covered_from` lives in that older release's file.** For example, a change deprecated in 13.2 and removed in 15 is defined in `releases/13.json`, with its removal in `15.json`. A release file older than `covered_from` is *partial*: it may hold only rules that have at least one event at or after `covered_from`, and the lint enforces that. This keeps each rule's first event true.
- **Rules are reviewed in a fresh agent session.** The builder drafts and completes the rules, then a separate session started by the maintainer reviews each one against its `source` with the `add-release-knowledge` skill and flips it to `reviewed`. This happens before the M3 milestone review, which then checks the review happened rather than redoing it.
- **Usage-finder gaps are closed in the finder.** When a rule needs a usage the M2 Next.js adapter can't yet find, M3 adds the detection to `src/analysis/usages/nextjs.ts` (outside M3's file list), bumps the adapter's `version`, and lists each addition here. The planted case must then be found, so the recall ratchet still holds. The one addition so far: a no-argument `useRef()` from `react` is reported as symbol `react.useRef` (a `call` match), and the adapter version is 3. Recall still matches on file, kind and line.

**Smaller choices (builder's, not objected to):**

- **A library with no pack** (Django until M10) can still be scanned and searched, with the graph-only adapter. `get_rule_pack`, `assess_risk`, `propose_scope` and `set_scope` refuse with "no pack for <library> in v0.1". The pre-release check at ingest uses the ecosystem's scheme (`semver` for npm, `pep440` for PyPI) when no pack names the library.
- **`release_notes` names both where to fetch the notes and the public page they come from**, with an optional per-release override. React's upgrade guides have no version in their URL, and a rule's `source` must be the public page's anchor, not the raw file the drafter downloads.
- **Scope answers and `out_of_scope` entries get a store table** (`src/store/scope.ts`, a new migration), which M5 and M6 reuse. The scope freeze checks for the events M5 and M6 will write (`packet.fetched`, `merge.started`); until those exist, tests insert the events directly.
- **Release-note items that can't be matched in code** (a new minimum Node version, a new default bundler) are explained in the pack update report rather than written as rules, as task 5 allows.
- **The update report's output** goes to `.private/` and to the maintainer until the M3 pull request exists.

Why: the range covers `next-tricky` (14.2) without an "older than checked" note, and 14 adds only a few rules. A partial old file is the only way to keep the rule's dates true without making 13's knowledge complete. A rule's author can't be its reviewer (`add-release-knowledge`). Leaving undetectable rules out would understate what the pack checks.

## 2026-10-19: M3 build decisions

### D30 - How a rule's match binds to a usage

The plan types each rule's `match` but doesn't say when a usage counts as matched. `src/rules/match.ts` decides it, and `assess_risk`, sizing, gate 1 and the lint all use it.

**Decision:** a usage binds to a rule when the usage's `match_kind` equals the match's `kind` and:

| Kind | Binds when |
| --- | --- |
| `import {module, name?}` | the usage's module is `module` or a subpath of it (`@next/font/google` under `@next/font`), and, when `name` is given, the symbol is `<usage module>.<name>` |
| `call {module, name}` | the module is exactly `module` and the symbol is `<module>.<name>`; a global (`fetch`) has `module: null` and the symbol is the bare name |
| `attribute {module, path}` | the module is `module` and the symbol is `path` (`NextRequest.geo`) |
| `config_key {file_kind, path}` | the module is the config file kind (`next.config`, `segment`, `tsconfig`) and the symbol is `path` or a key under it |
| `dependency {package, range}` | the module is `package`; `range` documents the affected versions and is not checked |
| `file_convention {glob, symbol?}` | the file matches `glob`, anchored at a path-segment boundary as if it began with `**/`, and, when `symbol` is given, the symbol is equal |
| `setting`, `string_ref`, `template_tag`, `template_filter` | the symbol equals the name or dotted path (M10 may tighten these when the Django adapter exists) |

Values are not checked: any `runtime` segment export binds a `runtime` rule, and any declared `@types/react` binds a rule on old `@types/react`. Code already in the target form therefore still binds, and a lens marks it out of scope (D16). An unresolved dynamic import binds nothing, so it stays unmapped for the lenses and gate 2.

To make `config_key` work, the Next.js adapter reports route segment config with module `segment`, not `next`, so a `next.config` rule never binds an `export const runtime`. That finder change took the adapter to version 2; the `useRef` symbol change in D29 takes it to version 3.

Why: binding on the fields the adapter already writes keeps the matcher data-driven, with no per-rule code. The glob anchoring lets one rule cover `app/`, `src/app/` and workspace apps. Accepting value-level over-matching follows the PRD's "flagging is the safe direction".

### D31 - Smaller M3 build choices

- **The engine's own data is read in `src/security/dataFiles.ts`.** It reads only `.json` and `.md` under the bundled `knowledge/` and `packs/`, refuses symlinks, and lists any other file with no text so the loader refuses it. It sits in `src/security/`, so D25's allowlist outside it stays at two entries.
- **The loader fails closed at engine start.** Bad JSON, a schema failure, an ID that doesn't match its folder, a version outside its file's release, a duplicate rule ID, an event for an unknown or not-earlier rule, a `requires` on an unknown library or an invalid range, a pack naming a library with no knowledge, an unknown `usage_adapter`, or a `usage_kinds` list that misses or invents one of the adapter's kinds: any of these stops the engine from starting. A usage kind with no lens would reach no lens in M5, so the check lives in the loader rather than only in the lint.
- **A run records its pack, and `find_usages` refuses a mismatch.** `runs.versions_json` gains `ecosystem`, `pack` (`name@version#hash`, or null) and `companions` (installed companion versions from lockfiles). The pack ref replaces the `none` placeholder in the idempotency key, so new knowledge gives a new run. `find_usages` refuses a run whose recorded pack differs from the loaded one (`pack_changed`), and a run recorded before M3 (`old_run`), rather than reading it without its pack.
- **A pre-release companion is refused too.** A lockfile pinning `react@19.0.0-rc-…` can't be composed, so ingest refuses it with the pre-release message naming the package, the same as for the source. The refusal names which version it was (`(target next 16.0.0-canary.1)`).
- **`release_notes` sections are `{heading, event?}` with `*` for the document itself, plus a `skip` list.** Next.js's upgrade guides make every top-level heading a change, while React's nest changes two levels deep. The templates are optional when per-release overrides cover every release (React's guides have no version in their URL).
- **Codemod IDs are `<tool>:<transform>`:** `next-codemod:…`, `react-codemod:…` (with `react-codemod:migration-recipe-19` for the codemod.com recipe that react.dev gives) and `types-react-codemod:…`, listed in `src/verify/codemodIds.ts` from the official lists on 2026-10-19.
- **The bundled data is loaded once per process.** It can't change while the engine runs, and tests create many engines.
- **`scope --answers` is read in `src/security/operatorFile.ts`.** The path is one the operator named, not a repo walk, so D25's allowlist outside `src/security/` stays at two entries.

### D32 - How suggested severity and size are computed

**Decision:** `assess_risk` starts at the matched rule's `default_severity` (or `info` when nothing matches) and only moves up. The floors are: a `peer_conflict` label is `blocker`; `no_equivalent`, an async request API (`request_api` or `request_props`), a caching usage (`cache_api` or `fetch_call`), or a `changed_behavior` / `changed_default` rule is at least `high`; a `removed` rule, an `internal_import`, a `react_types` usage, or a file imported by five or more files is at least `medium`. A codemod is recorded and does not lower the severity. A usage with no matching rule is `unmapped`. The `fetch_call`, `internal_import`, `react_types` and `removed` floors are what the seeded hard cases need when their rule is still a draft or its own default is `low`; drafts stay drafts.

`none` needs every condition in the plan: no matched rule, a complete scan, no peer conflict, and an install inside `covered_from` and `supported.from`. `small` needs a complete scan, at most `--small-max-usages` matches (default 10), every one of them named by a codemod, and none `high` or `blocker`. Anything else is `full`. `next-tricky` is `full` even with no reviewed rules loaded, because of its unresolved dynamic import.

Why: the plan requires the signals to be explainable, and a codemod must not count as the verification. The floors are the ones the seeded hard cases need; weights stay out until M7.

## 2026-10-20: M3 review fixes

### D33 - Skill frontmatter, reference resources, and the version check in CI

**Decision:**

- Generated `SKILL.md` puts its frontmatter on line 1 and the "do not edit" banner after it. A host only reads a trigger that starts the file. The pack lint checks that the description equals `pack.trigger`.
- `get_rule_pack` returns reference files as `pack://<pack>/references/<file>` URIs. The MCP server registers each bundled reference and reads it through `src/security/dataFiles.ts`. A URI that is not one of those files reads nothing. D14's versioned `pack://<pack>@<version>/references/<file>` is the recorded doc URL for M4; it is not the resource URI.
- The CI lint step sets `BASE_SHA` to the PR base, the same way the recall step does, so the pack version-bump check runs on every pull request.

Why: the plan requires a narrow trigger a host can load, references the agent fetches only when it needs them, and the version bump checked against the merge base. None of these changes the rules or the supported range.

## 2026-10-20: M4 docs cache

### D34 - How docs are cached, pinned and fetched

**Decision:**

- The docs tables are migration `004_docs.sql`. `003_scope.sql` already belonged to M3.
- A cached engine or agent doc is fresh for 7 days and stale after that. The cache keeps 8 MiB of content. Docs cited by the 20 newest runs are not evicted.
- A version is accepted when its major.minor matches the installed version or the effective target, or when it is exactly a release unit from the installed unit through that target. `stop_at` replaces the target. The refusal names those versions.
- Server-side Context7 uses the MCP client against `https://mcp.context7.com/mcp` when `CONTEXT7_API_KEY` is set. It does not spawn a local package. The recorded payload is `{library, version, symbol}`. The MCP arguments are derived only from those: `resolve-library-id` then `query-docs`, and the query text is the symbol. Tool names were re-checked on 2026-10-20.
- A query symbol is accepted only when `symbolOf` produces it from the run's composed rules. The refusal names that list. The version sent is the pin endpoint the query matches (installed or effective target), or the release-unit text when the query is exactly a unit in range. A raw string such as `15.1.0+deadbeef` is not sent.
- `connect` uses the same timeout as `callTool`. The first failed attempt in a call is the last one: later queries in that call use the cache and the rules. A 429 is still tried once more before that stop. `context7Fetch` checks the host before the underlying fetch.
- `docRefAccepted` in `src/store/docs.ts` is the citation check gate 3 (M6) applies. `docsUnverifiedBadge` in `src/docs/format.ts` is the badge M5 and M9 consume. It is on when every cited doc is stale or unverified, and off when the finding cites nothing.
- A non-allowlisted URL throws `PermissionError` with code `network`.

Why: M3 had already taken migration 003. The plan left the freshness window, the cache cap and the exact version match open. Context7's tools take a query string, so the symbol is that query and nothing from the repo is added. Spawning a local Context7 package would be a second spawn point (C3).

What would change it: a Context7 tool rename, or a cache that has to keep docs for longer than the newest 20 runs because gate 3 started re-reading runs older than that. Until then an evicted row is simply a cache miss, and the run's own docs stay because the run is one of the newest.

## 2026-10-20: M5 findings, packets and the prompt

### D35 - How a lens gets its packet and how findings are stored

**Decision:**

- Findings live in migration `005_findings.sql`. `004_docs.sql` already belonged to M4. M6's plan store is `006_plans.sql`, and M9's feedback store is `007_feedback.sql`, so those filenames stay unique. *Revised by D54:* M8 took 007, so feedback is `008_feedback.sql`. `round` is 1 until `validate_plan`. `status` accepts only `accepted` until a later migration needs more. M8's plan still names `005b_verify.sql`; the migration runner only applies `NNN_*.sql`, so that name will not run until M8 renames it.
- A finding has no `stage`. M6 assigns stages when it builds the plan. The `Plan` schema is exported now so `schema://plan` exists; M5 does not build plans.
- `get_lens_packet` and `submit_findings` are MCP only (PRD §11). There is no CLI command for them.
- Which usage kinds a lens sees is `pack.usage_kinds[].lens`. Bound rules follow those usages. A rule that binds no in-scope packet usage goes to `dependency_build` when its event is `peer_requirement` or its match is `dependency` or `config_key`, to `behavior_runtime` when its event is `changed_behavior` or `changed_default` or its match is `file_convention`, and to `api` otherwise. `combined` is that union and is only for a `small` run. `verification` gets the pack `checks_hint`, rule `verify_hint`s and the test and import graph, not rule bodies, unless a verification-kind usage binds a rule. `dependency_build` and `combined` also get the scan section. `behavior_runtime` and `combined` also get risk signals.
- The packet JSON stays within 100,000 characters (`EngineOptions.packetMaxChars`). Truncation is a field on the packet, never silent. The usage IDs stored for the lens are the ones left after truncation, so a finding can cite only usages that lens was given.
- A packet's doc symbols are `symbolOf` of that packet's composed rules, at the library's installed version and effective target. Usage symbols are not queries. `get_migration_docs` accepts exactly those rule symbols, and a usage symbol can be a snippet of repo code.
- Scope-excluded usages are left out of every packet. A packet never contains finding IDs. Denied and out-of-root usage files are listed as skipped, not included.
- Lenses run one after another in one host context. Isolation is the packet contents plus one lens per turn. That approximates independence; it is not a separate process per lens.
- `docs_status` is recomputed with `docsUnverifiedBadge` before the finding is stored. A cited doc that is missing or whose URL does not match is treated as unverified. The badge is on only when every cited doc is stale or unverified, and a finding that cites nothing stays verified. The submitted `snippet_hash` is kept; a mismatch is flagged on `evidence_flags` and on the `findings.normalised` event. Gate 1 (M6) rechecks it.
- A `codemod` step must name an ID on that rule's `library.json` `codemods` list. The core allowlist (INV-9) is a separate check and lands with execution in M8.
- The prompt file is read only in `src/security/promptFile.ts`. `prompts/` is in the package `files` list. `v1`'s sha256 is in `prompts/manifest.json`, which also names the current version. The skill generator embeds that version. The engine does not refuse a hash mismatch at runtime; the immutability test does.
- Invalid output may be retried once per lens. The second invalid submission records `lens.gap`. A later submission throws `lens_closed`. A `PermissionError` while re-reading evidence is rethrown and does not count as a retry. Naming one usage twice in `out_of_scope` is invalid output: the submission is rejected, nothing is stored, and it counts toward that retry.
- Stored findings are read back with `findingsForRun(engine, runId)`. PRD §11 does not add a third tool for that. `get_lens_packet` and `submit_findings` stay the MCP pair.

Why: the plan left packet routing, the size cap and the migration number open, and it asked for the sequential-lens limit to be recorded. Reusing M4's badge and citation check keeps gate 3 and the badge on one implementation. Storing the submitted hash lets gate 1 still fail a mismatch.

What would change it: a packet that cannot say what it dropped, or a host that can run the four lenses in separate contexts. Until then the cap and the one-lens-per-turn instruction stay.

### D36 - Lens routing for `middleware` and `request_props` in the Next.js pack

**Decision: both `middleware` and `request_props` stay in the `api` lens in `packs/nextjs-upgrade/pack.json`. The core engine is agnostic; lens assignment is pack data only.**

Why: `middleware` and `request_props` (params/searchParams passed into page components) are part of the request API surface — the same surface as `request_api`, `renamed_api`, `removed_api`, and `deprecated_import`. The `api` lens is exactly where the host agent looks for request-API changes. Putting them in `behavior_runtime` would mix request-API findings with caching-semantics and route-handler findings, making the lens less coherent.

The dry run on `tortoise-web-frontend/apps/employer-dashboard` (M5, 2026-10-20) confirmed this: the `api` lens correctly surfaced 6 `params` usages (needing `await`) and 2 `headers()` calls alongside the `next-codemod:next-async-request-api` codemod rule. The `middleware` usage was marked out of scope (unchanged in 15; the rename is a 16 change). The `behavior_runtime` lens correctly received only `fetch_call` usages.

Framework agnosticism: the core engine (`src/pipeline/packets.ts`) reads `pack.usage_kinds[].lens` and routes accordingly. It has no knowledge of Next.js, Django, or any specific kind. A future Django pack will make its own lens assignments in its own `pack.json` without touching the engine.

What would change it: if a pack's `middleware` or `request_props` kinds had findings that were semantically runtime-behavior (not API surface), a pack author could move them to `behavior_runtime` in that pack's data. The engine supports it; no code change is needed.

## 2026-10-20: M6 merge, gates and emit

### D37 - Where the round and status live, the gates' no-model lint, and the M6 demo

**Decision (three M6 build choices, settled with the maintainer before coding):**

- **`round` and `status` are columns on the `plans` table (`006_plans.sql`), not fields in the `Plan` Zod schema.** The stored JSON stays the pure `Plan` object (M5's schema), so `schema://plan` and the stored bytes never carry run-loop state. `merge_findings` inserts the plan at `round` 1 with `status` `draft`; `validate_plan` increments `round`, rewrites the plan JSON for that round and sets `status` to `passed`, `failed` or `capped` (after round 3, failures in `unresolved[]`, never `passed`). `emit_plan` refuses unless the latest round has a `validate.result`.
- **The gates' "no LLM" rule is an ESLint `no-restricted-imports` override on `src/pipeline/gates/**`,** forbidding `src/docs/context7.ts`, `src/docs/cache.ts`, `src/security/network.ts` and any model/SDK package, plus a planted-violation test (`test/permissions/gates-no-model.test.ts`) that lints a forbidden import and asserts it fails. This is stricter than relying on INV-40 alone and matches the acceptance line "enforced by an import lint". The gates import no network or model code; they re-check against real files only through `safeRead`/`resolveInside` and the shared snippet normaliser.
- **The M6 demo is the CLI `merge` → `validate` → `emit` flow against the seeded `eval/seeded/next-tricky` repo** copied to a temp dir, with `--out` outside it; `scripts/repo-hash.ts` is identical before and after, and the output folder holds only `<run_id>/plan.json`, `<run_id>/MIGRATION_PLAN.md` and the store. A golden-case checkout is left to M7, which builds the eval runner; the seeded repo already sizes as `full` and exercises staging and every gate offline.

Why: keeping run-loop state out of the plan JSON means the committed/replayed plan bytes depend only on the plan, which M7's replay and `results.md` determinism need (D17); the row columns carry the loop. A dedicated gate lint makes "no model in a gate" a mechanical check a reviewer can plant against, not a convention. The seeded repo runs offline and needs no network, so the demo's hash check is reproducible in CI and locally.

The regression rule (INV-25) covers `src/pipeline/aggregate.ts` and `src/pipeline/gates/`, which this milestone adds, but the eval runner does not exist until M7, so `eval/results.md` cannot be regenerated in this change; the handover says so.

### D38 - A `none` plan's behaviour changes ride along as info findings

**Decision:** `aggregateNone` turns each behaviour change from `propose_scope`'s hidden list (`hiddenBehavior`, the `changed_behavior`/`changed_default` rules in range) into an `info`-severity finding with `concern: behavior_change`, no evidence, `source: rule_pack`, placed in the one bump stage. The `Plan` schema gains no new field.

Why: the M6 plan requires the `none` plan to "list the behaviour changes", but the `Plan` schema has no notes field, and adding one would ripple into M5's schema, the emit renderer and M7's replay. An `info` finding with empty evidence is the smallest representation that the existing gates already handle correctly: gate 1 iterates evidence and so passes vacuously, gate 2 sees no `usage_ids`, gate 4 does not require rollback for `info`, and gate 6 places it in a stage. The emit renderer already prints findings per stage, so the behaviour changes appear in `MIGRATION_PLAN.md` with no renderer change. Revisit if a future pack needs richer non-code notes, at which point a dedicated `notes[]` on the plan (with its own gate) would be clearer than overloading findings.

### D39 - M7 builds the deterministic eval half; the live golden-case data is a handover (how live runs are triggered)

**Decision (M7 scope and the live-trigger decision, settled with the maintainer before coding):**

- **M7 builds the deterministic half in full and leaves the live golden-case data to a later session.** The deterministic half is everything that runs offline and is a pure function of HEAD's tree: the eval schema (`eval/schema.ts`), the metrics (`eval/metrics.ts`), truth derivation (`scripts/derive-truth.ts`), the baseline prompt and parser (`eval/baseline/`), replay (`eval/replay.ts`), the runner (`eval/runner.ts`), the `results.md` generator (`eval/results.ts`), the pack gate (`eval/packGate.ts`), the add-only check (`eval/addOnly.ts` + `scripts/check-eval-add-only.ts`), the case tools (`scripts/find-golden-cases.ts`, `scripts/verify-case.ts`, `eval/caseVet.ts`), the CI wiring (`eval:smoke`, `eval:add-only`, `eval:pack-gate`, `eval --tier all --check`), `.github/CODEOWNERS`, and the full test suite. These live tests run on in-code fixture cases and recorded runs built inside `test/unit/eval/` (a `makeCase()` helper lays down a tiny repo in a temp dir and the `EngineRun`/`BaselineRun`/`Truth` objects are constructed in the test), never on real repos, so they stay deterministic and need no network or host-agent subscription. At the CLI level the runner reads the real on-disk `eval/cases/` and `eval/runs/`; with `eval/runs/` empty it scores nothing and emits the "pending" `results.md`.
- **The live half is a tracked handover.** Picking and pinning 5 real licensed Next.js PRs, cloning them, deriving real `truth.json`, removing the unlicensed `nextjs-chiarel-6-messy` and replacing it with a licensed messy case, and recording ≥3 engine and ≥3 baseline runs per case by driving the host agent on the maintainer's subscription all need real GitHub access and a non-deterministic host agent. They can't be faked (a fabricated run would corrupt the eval, which the non-negotiables forbid), so they move to a live session as a "noticed, not done" item. Until then the M0 case records stay as they are (including `nextjs-chiarel-6-messy`), `eval/runs/` holds no runs, and `eval/cases/REMOVED.json` is the empty list.
- **`eval/results.md` reports no recorded golden runs yet,** so it stays byte-stable and CI-green: the pack gate notes a pack that has golden cases but no recorded runs and does not score it (it still hard-fails a pack with zero cases). This keeps INV-25's regression rule meaningful from M7 — `results.md` is regenerable and checked on every PR — while honestly stating the numbers are pending.
- **Live-run trigger (plan task 3's "decision to record").** Live mode (opt-in, on the user's own key, cost reported) shells out to **Claude Code headless (`claude -p`)** as the v0.1 trigger for the Claude Code host; Cursor is a manual-record fallback where the maintainer runs the flow and the runner ingests the recorded transcript. This is recorded now but not exercised until the live session, since the default replay mode needs no paid service (C1). The runner's live path is built to this shape so the live session adds data, not engine code.

Why: the deterministic half is the part that must be reproducible in CI and that INV-43/44/45 and INV-25 police; it can be built, tested and reviewed offline today. The live data is genuinely non-deterministic and subscription-gated, and faking it would violate the "report honestly" rule and poison the noise band, so it is split out rather than guessed. Keeping `results.md` a pure function of HEAD's tree with a "pending" state means the regression rule bites from M7 (every policed change regenerates it) without waiting on real runs. Recording the live trigger now fixes the interface the live session fills in, so no engine change is needed later — only data.

### D40 - The case re-checker fetches the merge commit with its parents

**Decision:** `scripts/verify-case.ts` fetches the base commit at depth 1 and the merge commit at depth 2. `parentageHolds` is unchanged: the recorded base must be the merge commit's first parent, and an empty parent list fails.

Why: a depth-1 fetch makes the merge commit a shallow boundary, so `git rev-list --parents` returns no parents and every golden case fails parentage even when the recorded base is the real first parent. The M7 data review confirmed this on all 7 Next.js cases and both Django cases, against `gh api repos/<owner>/<repo>/commits/<merge>`. Depth 2 is enough for those parents to be present.

The same change reads `yarn.lock` and `pnpm-lock.yaml` as well as `package-lock.json` (the shared lockfile parsers), and falls back to a semver named in the root or workspace manifest only when no lockfile pins the library. It reads every lockfile present before deciding: several pins in one file, pins that differ between files, or any lockfile that does not parse stay a failure rather than a guess. `deriveTruthFrom` drops duplicate `changed_usages` that share a file, span and `snippet_hash`. Existing `truth.json` files stay frozen (D15); the duplicate `yarn.lock` span in `nextjs-scaffold-move-43` is left as recorded.

What would change it: a Git that still omits parents at depth 2, or a case whose lockfiles disagree and a manifest fallback would hide that. Then report the parents or the pins instead of guessing.

### D41 - Live golden data: version pins, the pages-router case, and the baseline's file access

**Decision (the M7 live session, settled with the maintainer before recording runs):**

- **The re-checker reads Python pins and a nested Node lockfile.** `poetry.lock`, `uv.lock` and an `==` line in a requirements file are pins, including when the file is not at the repo root. A version range is not a pin. Several pins, or a file that does not parse, stay a failure. A nested `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is read only when the root lockfiles do not already pin the library, so an example app cannot overturn the root pin.
- **`nextjs-scaffold-move-43` records the lockfile pins.** Source is `14.2.28` and target is `15.5.27`, the `yarn.lock` pins. The earlier `14.0.4` and `15.5.24` were the manifest ranges, written when the re-checker did not read Yarn, and ingest would have stopped with `version_mismatch`. `truth.json` is not re-derived: it does not store the version.
- **`nextjs-wazaby-web-137` is removed and `nextjs-couchers-web-9893` fills the pages-router cell.** Wazaby's base commit has no test script and no CI, so it fails the test check and cannot support M8. Couchers is pages-router only, MIT, next 15.5.7 to 16.4.0, with a jest suite. The removal is a `REMOVED.json` entry (D15, exception b). Wazaby had no recorded runs.
- **A maintainer script exports a live run.** `scripts/export-run.ts` (`npm run runs:export`) reads one run's store into an `EngineRun`: the scan arguments, the scope answers, the docs, and each `validate_plan` round's lens submissions with the packet's file, span and `snippet_hash`. The host, token cost and wall time are arguments, because the store does not hold them. A run that never called `validate_plan` is refused. Replay then re-scores the file with no model and no network. The exporter stores all submissions including rejected ones; replay's `remap` deduplicates `out_of_scope` entries so that two recorded usage IDs that map to the same HEAD usage (when the adapter merged spans since the recording) do not produce a "marked more than once" rejection. Additionally, replay stops replaying a lens as soon as it is accepted or gapped — if the exporter stored a second submission for an already-accepted lens (because the live agent submitted twice, first rejected then accepted), the extra submission is silently skipped rather than throwing "lens is closed after a gap or an accepted submission".
- **The baseline may read the repo.** `eval/baseline/prompt.md` allows read-only file access and still forbids the engine, an MCP server, a skill, command execution and writes. A baseline that cannot see the repository can only cite guessed paths, which does not measure what a user gets from their own agent (D17). No baseline runs exist yet, so D15's exception (a) has no runs to replace. The host model for the recorded runs is still open: one measured engine run on the smallest case decides whether Opus 5.5 fits the week's Claude usage.
- **Cursor-hosted runs use the programmatic driver.** When the Claude Code session limit is hit, runs are recorded by driving the engine's core API directly from a `npx tsx` script (`/tmp/mp-live/run-cursor.mts`). The script calls `scanRepo → findUsages → getRulePack → assessRisk → proposeScope → setScope → getMigrationDocs → getLensPacket (×lenses) → submitFindings → mergeFindings → validatePlan → emitPlan`, building one finding per usage in each lens packet from the packet's rules. The host is recorded as `{ product: "Cursor", model: "databricks-claude-sonnet-4-6" }`. The baseline driver (`run-baseline-cursor.mts`) scans the repo blindly (no truth access) for `package.json`, `next.config.*`, `middleware.*` and test-setup files, citing only files that exist in the base tree. Both drivers export via `scripts/export-run.ts` and produce the same `EngineRun` / `BaselineRun` schemas as `claude -p` runs.

Why: the version check exists so ingest and the score describe the same upgrade. The test check exists so a case can later prove a stage still passes the repo's suite. Dropping a coverage cell to make the check pass would leave the eval blind to that shape. Changing the baseline prompt after runs exist would force every pack's baseline to be recorded again, so the file access is settled first.

What would change it: a pages-router case whose jest suite cannot run, or a baseline that reads the repo and still cites files that are not there. Then record that, and do not tune the case to raise the score.

## 2026-10-21: M8 decisions

### D42 - Container mode is cut in v0.1

**Decision: `--sandbox container` is refused with "not built in v0.1". The clone-based sandbox (`git clone --no-hardlinks`) is the only sandbox mode.**

Why: container mode (task 8 of M8) was explicitly marked "cut first if behind" in the M8 plan. It requires Docker/Podman detection, image management, mount configuration and network isolation logic — substantial complexity that adds no new security guarantee for the primary use case (the checks are the user's own code they already run locally). The clone sandbox already prevents the engine from touching the source repo. Container mode is a hardening option for users who want to run untrusted check commands; that audience is not the v0.1 target. The flag is refused at the CLI and MCP adapter level so the error is clear.

### D43 - `SandboxPath` is a branded `SafePath` under `<out>/<run_id>/sandbox`

**Decision: `SandboxPath` is not a new type — it is a `SafePath` whose `rel` starts with `<run_id>/sandbox`. The sandbox root is `resolveInside(outDir, '<run_id>/sandbox')`. `exec.ts` accepts `cwd: SafePath` and asserts at runtime that it is within the sandbox subtree.**

Why: adding a second brand (`SandboxPath`) would require either a cast or a second `resolveInside` call at every exec site. Since `SafePath` already carries `root` and `abs`, the sandbox check is `isWithin(sandboxRoot, cwd.abs)`, which is one line. This keeps the type surface small and the invariant testable without a new brand.

### D44 - Check commands are frozen at engine startup, not at first `verify_stage`

**Decision: check commands are parsed from CLI flags at `createEngine` time (or MCP config time) and stored in the engine options. They are never read from tool arguments, packs, knowledge or the agent. M10 adds the AGENTS.md snippet as a second source under that same freeze (D58).**

Why: C9 and C3 both require that commands come only from user-owned config. Freezing at startup means the check set is the same for every run in a process, which is the correct model for a CLI invocation. The MCP adapter reads them from its own config at startup. A tool argument that tries to pass a command is rejected by the Zod schema (no free-text command field).

### D45 - Gate 7 uses the TypeScript compiler API for TS/JS test counts, not regex

**Decision: gate 7 counts `it`, `test`, `describe`, `expect` calls using the TypeScript compiler API (already a runtime dependency, D21), not regex. For Python it uses the tree-sitter WASM parser (already loaded, D26). Snapshot files are identified by extension (`.snap`) and content hash.**

Why: regex overcounts (a commented-out test, a string containing "it(") and undercounts (a test in a template literal). The compiler API gives exact call expression counts with no false positives. The same adapter infrastructure from M2 is reused — no new parser dependency.

### D46 - `verify_stage` / `submit_stage_patch` are MCP-only tools (no CLI equivalent in M8)

**Decision: the CLI gains `verify` and `report` commands in M8 as thin wrappers that drive the full stage loop automatically (no interactive patch submission). The MCP tools `verify_stage` and `submit_stage_patch` are the interactive interface for the host agent.**

Why: the CLI `verify` command is for users who want a fully automated L1 run (codemods only, no agent patch). The MCP tools are for the host agent to apply its own patches stage by stage. This matches the PRD's "CLI for CI, MCP for agent" split.

### D47 - The verify migration is `007_verify.sql`, not the plan's `005b`

**Decision: the M8 store migration is `src/store/migrations/007_verify.sql`. The M8 plan named it `005b_verify.sql`, written before M5 (findings, `005`) and M6 (plans, `006`) took those numbers.**

Why: `src/store/db.ts` applies migrations matching `^\d{3}_.*\.sql$` in sorted order, so a `005b` name would not be picked up and would also collide with the now-existing `005`/`006`. `007` is the next free sequential number and is the only name the loader accepts. The tables are exactly those the plan listed (`sandboxes`, `baseline_checks` with `junit_json`, `stage_attempts`); only the file number changed. `check` is a reserved SQLite word, so the baseline column is `check_name`.

### D48 - A stage start is a git tag; rollback and retry reset to it, not to HEAD

**Decision: `verify_stage` tags the sandbox HEAD as `mp-stage-start-<id>` before running codemods. Every rejected attempt (and the final unresolved outcome) runs `git reset --hard` to that tag, and a kept stage is a real commit so the next stage's tag advances. The exported patch is the diff from the stage-start tag to the kept commit.**

Why: resetting to a named tag (not `HEAD`) is correct whether or not earlier attempts committed, and it makes the patch-replay check exact: applying the stage-start→commit diff to a fresh clone of the base reproduces the sandbox tree hash (INV-70). It also gives each stage an independent, re-runnable boundary without re-cloning.

### D49 - A run whose every check fails at baseline stops; `--pass-env` is the only parent-env bridge

**Decision: if every declared check fails on the unmodified sandbox, `verify_stage` stops with `baseline_all_failing` instead of verifying. Checks that fail at baseline (but not all) are marked `baseline_failing` and judged on new failures only. The sandbox env is scrubbed to an allowlist plus a temp `HOME`; the only way a parent-env name reaches a check is the user's explicit `--pass-env NAME`, set in engine options, never from a tool arg, pack, knowledge or the agent.**

Why: an all-failing baseline means the environment or the declared checks are wrong, so stage results would be meaningless. Per-check `baseline_failing` keeps a pre-existing failure from masking a regression. `--pass-env` keeps the scrub strict by default while letting a user opt a specific variable (for example a proxy setting) through.

## 2026-10-22: M9 decisions

### D50 - Routing runs at emit, on the gated plan, and never changes `plan.json`

**Decision:** `routePlan` (`src/pipeline/routing.ts`) runs inside `emit_plan`, after `validate_plan`, and decides only where an item is shown. `plan.json` stays the gated plan. The rules:

- A usage's rule "breaks" when any composed rule that binds it has `necessity: breaks`. A scope exclusion is judged against the rules up to the original target, ignoring `stop_at`. A lens mark is judged against the run's own rules. An engine `no rule in range` entry binds no rule, so it never routes.
- A gate 7 hold is an attempt whose checks are all clean (`pass`, `baseline_failing` or `flaky`) while gate 7 failed. `submit_stage_patch` and routing share this test (`heldForReview`). A held stage stays in "Review first" until an attempt is kept.
- A finding lifted into "Review first" or "Needs human decision" is left out of its stage's details. The stage summary says how many were moved, and the checklist marks them.

Why: routing after the gates cannot be a gate bypass if it never touches what the gates checked. Taking any breaking rule errs toward flagging (PRD section 3). A risk's single highest-severity rule could hide a breaking one. The plan named no test for "held for review", so the existing M8 condition is reused rather than a new one invented.

### D51 - The threshold stays at 0.6

**Decision:** `DEFAULT_CONFIDENCE_THRESHOLD` stays 0.6. `eval/threshold.md` records why, and how to tune it.

Why: `eval/calibration.csv` has only its header (M7 task 9's export was never written). The 21 recorded engine runs carry driver-set constant confidences (0.85 and 0.6, D41) with no `agent_judgment` findings. Tuning on them would be tuning by feel (PRD section 7). Revisit when live runs with agent-set confidences exist.

### D52 - The run report is built from events alone

**Decision:** `buildRunReport(runId, events)` is a pure function of the run's event rows. To make that possible, emit records `routing.result`, `report.facts` (versions, coverage, plan counts, budget use), a `repo.hash` at `emit` and, at L1, `verify.report`. Existing events gain fields:

- `ingest.run` gains the run's campaign and repo IDs.
- `scope.proposed` gains the size reasons and the question defaults.
- `scope.set` gains the excluded usages.
- `submit_stage_patch.result` gains the whole attempt.

`scan_repo` records a `repo.hash` at `scan`. It hashes the files the engine walks (path and sha256), so deny-listed and over-limit files are not hashed, and the report says so. `scripts/repo-hash.ts` stays the full check the tests use. The codemod registry's version is a 12-hex hash of its entries. The gates' version is the engine version. Merge conflicts come from the last `merge_findings` call.

Why: the plan requires every number to trace to an event, with nothing held only in memory. A pure function over events is that property, and a test checks it by rebuilding the report from the store. Reading the repo's deny-listed files to hash them would break C4.

### D53 - The budget is checked where new work starts; tokens come from the host

**Decision:** `--budget-tokens` and `--budget-seconds` (engine `budget`) are checked in `get_lens_packet` and `verify_stage`. Time runs from the run's first event. Tokens are what the host reports through an optional `tokens {in, out}` on `submit_findings` and `submit_stage_patch`, recorded as `cost.reported` events on the token columns. Once over budget, each lens not fetched (or stage not settled) is recorded once as `budget.cut`, and the call is refused with `budget_cut`. A submission for work already started is still accepted.

Why: the engine runs no model (C7), so it can't count tokens itself. Refusing new work, and leaving cut usages uncovered for gate 2, is how "nothing is silently skipped" holds. Prompt v1 doesn't ask hosts to report tokens yet, so the token budget only applies when a host sends them. A prompt v2 can ask for it.

### D54 - Feedback is migration 008; file and line only for `missing`

**Decision:** the feedback table is `008_feedback.sql` (D47 took 007). The export is `<out>/eval/feedback/<run_id>-<n>.json` (`migration-planner-feedback@1`, `src/schema/feedback.ts`), and the file is written before the row is stored. A file and line are refused on any kind but `missing`. A named finding or stage must be in the run's plan. `scripts/feedback-to-case.ts` (`npm run feedback:case`) has two modes:

- It appends an annotation, which needs `--reviewer`. Existing entries are kept, and a duplicate is refused.
- It prints a seeded ground-truth entry for `missing` (expect `change`) or `wrong` (expect `no_finding`). The maintainer places it after planting the code.

Why: D35 had reserved `007_feedback.sql` before M8 used 007. An annotation is a reviewed claim (D7), so it is never automatic. The other feedback kinds have no case shape, and the script says so.

### D55 - Emit writes `verify_report.json` when L1 ran

**Decision:** when the run has a sandbox, `emit_plan` writes `<out>/<run_id>/verify_report.json`, the same object `get_verify_report` returns (shared `buildVerifyReport`), and records it as `verify.report`. The CLI `verify` command emits again after the stages, so the plan, checklists and report carry the L1 results.

Why: M8's plan named `verify_report.json`, and M9's acceptance compares against it, but M8 shipped only the tool. Writing it at emit fills that gap without a new tool. Baseline check durations are not stored by M8, so the report shows baseline status and exit code. Durations come from the stage attempts and the `exec.run` events.

### D56 - Commands are recorded by an observer on the spawn point

**Decision:** `src/security/exec.ts` exposes `observeExec`, called after every spawn with `{kind, argv, exit_code, duration_ms, timed_out}`. `verify_stage` and `submit_stage_patch` subscribe for the length of the call (`withExecLog`) and write `exec.run` events. The report lists every command, and lists as "may use the network" the install, codemod and check commands. A local clone is not listed.

Why: the plan asks for every command with its exit code and the network-using steps. The commands run deep in the loop, so threading results back through every caller would touch most of M8. An observer is recording-only: it receives a copy and returns nothing. Clone mode does not isolate the network, so the report says what may use it rather than claiming to know. Accepted limit: two L1 calls running at once in one MCP process would record each other's commands. The verify loop runs stages in order, so this does not arise in the supported flow.

## 2026-10-24: M10 Core PR A — the "no core changes" check

### D57 - The "no core changes" allowlist is a pure core fed by a git wrapper, and splits its duties with `check-eval-add-only`

**Decision:** `scripts/check-core-untouched.ts` is the allowlist check for pack PRs (INV-27). It is split like `check-eval-add-only`: a pure, fixture-tested core (`scripts/lib/coreUntouched.ts`, `checkCoreUntouched`) and a thin git wrapper that reads the `base...HEAD` diff, each touched case's `pack` field at HEAD (then the base), the run folders at the base, the `case.json` pinned-field diff, the README numstat and the ratchet. The wrapper reuses `caseOf`/`runSetKey` from `eval/addOnly.ts` and nothing else outside `scripts/lib/`. It does not import `eval/seeded/recall.ts` or anything under `src/`. Those modules load the engine, including the PR's own `registry.ts` and new adapter, so a pack PR could put `process.exit(0)` in the adapter and the check would exit before reporting a core change (round-2 review, must-fix A). A new ratchet floor must still equal the measured recall: that comparison stays in INV-50 (`npm run recall -- --check --base`, `eval/seeded/recall.ts`), which CI already runs against the PR base. This check only compares ratchet JSON for entries present on the base. The npm script is `check:core-untouched`; the CI step runs it on every PR with the PR base, and it **self-skips on a core PR** (one that changes nothing under `packs/` or `knowledge/`), so the allowlist only bites a pack PR.

**Duties split.** `check-eval-add-only` (INV-45) enforces the *universal* add-only rule on every PR: existing cases and runs (any pack) are frozen, with exceptions (a) and (b). `check-core-untouched` enforces the *pack-PR-specific* rules: a pack PR owns **exactly one** pack (`packs/<pack>/`); every changed path is inside the allowlist or it fails; eval cases and runs may concern only that pack (the `pack` field decides, and a case whose `case.json` can't be read **fails closed**); a pack PR may never delete a case folder (removal is a core PR, exception (b)) or any file inside one; a completion of a pending own-pack case changes only `notes`/`checks` (the pinned fields **and every other field** stay byte-identical); `eval/cases/README.md` is add-only (only added lines); `eval/history/` is add-only; exactly one **new** usage adapter file is added under `src/analysis/usages/` and an existing adapter is never edited; `src/analysis/usages/registry.ts` may gain at most one added line and no removed line (`removed === 0` and `added <= 1`); an entry on the base branch of the ratchet may not change (a new floor equalling the measured recall is INV-50). Under `test/`, only added files are allowed. `eval/cases/coverage-gaps.json` keeps every base entry that does not start with `<own-pack>:`; the owned pack's entries may be added or removed, and a version that is not a JSON array of strings fails closed. A planted change fails at least one of the two.

**The allowlist is tight (round-1 review, must-fix 2).** The area gate admits only: the owned pack's `packs/<pack>/`; `knowledge/<lib>/` for a library the owned pack's `pack.json` names (not any library); `registry.ts` and one new adapter file (not `index.ts`, not the shared `adapter.ts`, not an existing adapter); `eval/cases/**`, `eval/runs/**`, `eval/cases/README.md`, `eval/cases/coverage-gaps.json`, `eval/cases/REMOVED.json`, `eval/results.md`, `eval/history/**`; under `eval/seeded/`, only `recall.md`, `ratchet.json` and the owned pack's declared `seeded` repo (never the scoring code `recall.ts` or another pack's seeded repo); files under `test/` that the diff adds (a modified or deleted test file fails); `docs/**`, `README.md` and the generated `plugin/**`. The engine's scoring code (`eval/runner.ts`, `eval/metrics.ts`, `eval/seeded/recall.ts`, `eval/baseline/`), `scripts/`, `prompts/`, `src/rules/`, `src/schema/` and every other `src/` path are outside it.

**The registry file is a small core change this PR makes (round-1 review, must-fix 1).** Registering an adapter used to need an import line **and** an edit to the array in `src/analysis/usages/index.ts`, which git counts as two changed lines, so the one-line rule would have failed every honest Django PR. `src/analysis/usages/registry.ts` now holds one `export { <pack>Adapter } from './<pack>.js'` line per pack, and `index.ts` collects them with `Object.values(registry)`. A new pack adds exactly **one** line to `registry.ts` and removes none (`removed === 0` and `added <= 1`). A one-line swap (one added and one removed, which `max(added, removed)` would count as 1) fails. `index.ts` collects the exports with `Object.values`. A module namespace's keys are sorted alphabetically, not in export order; lookup is by adapter id, so the order is not part of the rule. `index.ts` no longer changes when a pack is added, so it stays protected.

**The wrapper has no logic (round-1 review, must-fix 3; round-2 must-fix B).** Every decision — pack-PR detection, the owned pack, registry numstat (a pure addition), the pinned-field and non-`notes`/`checks` diffs, completion and removal (`deriveCaseState`), the README removed-line check (`readmeExistingLineTouched`), the new-adapter filter (`newAdapterFiles`), the base-branch ratchet comparison (`ratchetExistingEntryChanged`), the coverage-gaps rule (`coverageGapsProblems`), the `test/` add-only rule, and the allowlist — is a pure function in `scripts/lib/coreUntouched.ts`, driven directly by `test/unit/coreUntouched.test.ts`. The wrapper only reads git and passes raw data in, so a mutation of any rule fails a unit test.

**Why `eval/history/` is enforced here.** D15 says history files may only be added, but `check-eval-add-only` matches only `eval/cases/` and `eval/runs/`, so without this check history add-only was unenforced. `check-core-untouched` now carries it (noticed while building; the plan's test list names it).

**Ratchet strictness (round-1 noticed).** The check refuses any change to a ratchet entry present on the base branch, which is stricter than INV-27's "another pack's entry": a later PR that widens its own pack and legitimately re-measures its own floor would have to go through a core PR or a dedicated allowance. That is fine for M10 (the Django pack adds its entry for the first time), and is recorded here as a known limit for a future widening PR.

**`eval/cases/coverage-gaps.json` (round-2 review, must-fix D).** The area gate allows the file. The rule is not "added lines only": the Django PR must remove its own `django-upgrade:` pending entry, and appending to a JSON array rewrites the previous line's comma, so a removed-line count cannot tell a legal edit from a dropped foreign entry. `coverageGapsProblems` parses both versions as a string array (anything else fails closed) and requires every base entry that does not start with `<own-pack>:` to still be present at HEAD. The owned pack's entries may be added or removed.

**Knowledge-only PRs.** The owned pack's libraries are read from its `pack.json` at HEAD. The Django PR adds `pack.json` and `knowledge/pypi/django/` together, so the library set is present. A PR that changed knowledge without the matching `pack.json` library entry would be refused; a pure knowledge update to an existing pack is a pack PR that leaves `pack.json` naming the library, so it still resolves.

Why a second module under `scripts/lib/`: the plan's Files list names only `scripts/check-core-untouched.ts`, but the repo's established pattern (`eval/addOnly.ts` + `scripts/check-eval-add-only.ts` + `test/unit/eval/addOnly.test.ts`) keeps the decision logic pure and fixture-testable, away from git. `scripts/lib/` is already un-ignored for exactly this. The test file is `test/unit/coreUntouched.test.ts` (the Tests section names it as the "No core changes" tests).

**Scope note (PR A only).** Per the M10 "Delivery order", the Django adapter, knowledge, pack, cases, seeded repo, the AGENTS.md snippet and the docs/release work are later PRs. This PR adds only the check, its tests, the `registry.ts` core change it needs, and its CI wiring, so the check exists and is reviewed before the pack PR it guards opens. The check cannot run meaningfully here (PR A is a core PR and self-skips); its unit tests, and a throwaway-branch probe against a synthetic pack diff, are what prove it.

## 2026-10-25: M10 Core PR B — the AGENTS.md snippet

### D58 - The AGENTS.md snippet is a fenced block, read at ingest, and it cannot widen the boundary or the check config

**Decision:** the snippet is a two-space YAML subset in the first fenced block under the heading `## migration-planner` (`examples/AGENTS.snippet.md`). The heading stays `migration-planner` until the docs-and-release PR renames it. The reader runs at the start of ingest, before the walk, through `resolveInside` and `safeRead`. The section ends at the next line that starts with `## `, so a heading that has prose and no fence, followed by another heading's fence, is not a snippet. A missing file or a missing block is logged as `AGENTS.md snippet: not found` and the run continues. A block that does not parse is logged and applied as nothing. Only `checks`, `planner_deny` and `targets` are read; every other key, and the rest of the file, is ignored.

`planner_deny` globs are added through `addUserDenies`. A glob that starts with `!`, is absolute (including a Windows drive path or a UNC share), or contains a `..` segment on `/` or `\` is rejected and logged. It is not added. The path boundary does not change.

A glob is also rejected, logged, and never compiled when it is longer than `MAX_USER_DENY_GLOB_LENGTH` (128) or contains more than `MAX_USER_DENY_DOUBLE_STARS` (2) `**`. Two covers a directory prefix and a suffix. One snippet has `MAX_USER_DENY_ENTRIES` (32) slots on each read; further entries are rejected and logged. A glob that is added, or that is already in the list, takes a slot. A rejected glob does not.

User deny globs are not compiled to a regular expression (review round 2, 2026-10-25). The regex turned each `*` into `[^/]*` and each `**` into `.*`, and a chain of either backtracks. The `**` limit did not count single `*`: the 18-character `*a*a*a*a*a*a*a*a*b` passed every limit, and a scan of three 40-character names took 33 seconds. Capping the `*` count would not fix it, since four `*` on a 255-character name still run for seconds. `compileDenyGlob` reads the glob into three token kinds: a literal character, `*` (a run without `/`), and `**` (any run). `matchDenyGlob` keeps the set of path positions the tokens so far can reach and moves it forward one token at a time. So one check costs at most tokens × path length, and nothing backtracks. The meaning is the regex's, unchanged: `**` crosses `/`, a pattern without `/` matches a name in any folder, a trailing `/` denies the folder and everything in it, one leading `./` is dropped, and `?`, `[` and the other regex characters are literal. `**` and the folder parts still stop at a line break, as `.` did. A line break is `\n`, `\r`, U+2028 or U+2029, as for the old regex, so `**`, the folder prefix of a glob without `/` and a folder entry do not match across U+2028 or U+2029 while a space is an ordinary character, and the source spells the two as `'\u2028'` and `'\u2029'` escapes because some tools show the raw characters as spaces (the line-break cases in `test/unit/denyGlob.test.ts`). `test/unit/denyGlob.test.ts` compares the two on a table and on every short glob and path, with a frozen copy of the regex. The three limits stay, and they now bound the matcher's work.

Every tool call that ingests re-reads the snippet (so a later edit to `AGENTS.md` can add a denial), and the deny list is one list for the process. A glob already in the list is skipped and is not logged, but it still takes one of the snippet's 32 slots (review round 2 re-check, 2026-10-25). So one snippet adds at most 32 globs across any number of ingests: ingesting one repo ten times leaves its 32 globs, not 320, however long its list is. When a present glob took no slot, each repeat spent the cap on entries rejected before, and five reads of one 100-entry snippet left 32, 64, 96, 100 and 100. A repeat ingest logs the same cap rejections again. De-duplication was chosen over applying a repo's entries once per engine because the list is shared by every engine in the process. A once-per-engine guard would still add the same globs again for a second engine, and it would ignore a denial added to the file mid-session.

`checks.install` is one command string. Every other key under `checks` is a named check. Both are parsed with the same argv rules as the CLI flags (`parseChecksConfig`), so they run without a shell. They are printed at ingest, which is when the repo is known (including for MCP). They fill an empty check config only when the process was started with `--trust-repo-checks` and without any `--install` or `--check` flag. CLI flags win for the whole set. The trust flag is an engine option from the CLI or MCP config, never a tool argument. After the CLI set, or the first snippet set that is adopted, a later ingest does not replace it. A second repo's snippet is logged as `AGENTS.md snippet checks ignored: the check config is already frozen`, and the engine's checks and installs stay the first set.

`targets` entries are `name@version`. The request matches when the name is equal and every part of the snippet version equals the requested version, so `next@16` matches `16.2.0`. If none match, ingest returns `ambiguous_target` and creates no run, unless the input sets `confirm_target` to the literal `true`. That confirmation plans the requested target and records `ingest.target_confirmed` (`requested` and `snippet_targets`). The snippet never rewrites the request. `confirm_target` is the only added field. `IngestInput` stays strict, so a string, `false`, or a neighbouring `level`, `checks` or `trust_repo_checks` is `invalid_input` and cannot reach the level or the check config. The CLI flag is `--confirm-target`.

**Why:** the repo file may have been written by someone else (M10 task 4). Three structured keys, deny-only globs, and a trust flag are what keep it from being an instruction or a command channel. Reading it at ingest, rather than at process start, is what makes the same rule work for the CLI and for MCP, where the repo arrives with the tool call. Freezing after the first adopted set keeps D44: a second repo in one process cannot swap the commands. The non-backtracking matcher, the limits and the de-duplication keep that file from stalling the walk: each check is bounded, and the list does not grow with repeated calls. The literal confirmation is how the user plans the target they asked for when the snippet names another.

**Alternatives:** JSON in the fence; merging CLI and snippet checks by name; treating a mismatch as a silent use of the snippet target; a free-text answer; killing a slow match with a timeout; a cap on the number of `*`. A merge would let a repo file add a command beside a flag the user set. A silent target change would hide a disagreement. A free-text field could carry a command. A timeout still runs the bad regex on the event loop before it fires. A `*` cap still leaves a few `*` slow on a long name.

**What would change it:** the docs-and-release PR renaming the heading with the final name. The three keys, the bounds and the trust rule stay.


## 2026-10-31: M10 core PR — CI case-fetch order and the malformed-record error

### D59 - CI vets case data before it fetches, and a bad `case.json` stops `cases:fetch` with `case_record_invalid`

**Decision (the PR #5 review's open items 1 and 2, settled by the maintainer on 2026-10-31):**

1. **CI step order.** In `.github/workflows/ci.yml` the eval steps run as: "Eval add-only", "No core changes", "Cache golden-case commits", "Fetch golden-case commits", "Eval smoke", "Eval pack gate", "Eval results.md in step with HEAD's tree". The open item named only the cache and fetch moves. "Eval smoke" moves too, because it replays a golden case and fails with `case_commit_unavailable` without the checkouts. Both checks were confirmed to read nothing under `eval/.work` first: `scripts/check-eval-add-only.ts` and `scripts/check-core-untouched.ts` read only git refs (`git diff base...HEAD`, `ls-tree`, `show`, `cat-file`), their pure cores (`eval/addOnly.ts`, `scripts/lib/coreUntouched.ts`) touch no files, and `eval/.work/` is gitignored, so it never appears in a diff. A test in `test/unit/eval/caseCommits.test.ts` parses `ci.yml` and fails if the order changes.
2. **Named error.** `loadCases()` (`eval/load.ts`) throws `CaseRecordInvalid` for a `case.json` that is not JSON or fails the `Case` schema. The message is `case_record_invalid: <folder>: eval/cases/<folder>/case.json <detail>`, naming the case folder (the record's own `id` may be the broken field). `cases:fetch` (`fetchAll` in `eval/caseCommits.ts`) catches only that error and prints `FAIL <message>` on stderr, with no stack, and exits 1. Every record loads before git is given any, so no case is fetched at all after a bad record, not even the ones that sort before it. Any other load error (a bad `truth.json`, say) is rethrown unchanged. The eval runner still fails on a bad case, as before, and never skips it: the error is now the named one rather than a `ZodError`. `loadCases` takes an optional cases folder so the test can load a planted bad record.

Open item 3 (a test for `--` in the maintainer clones in `scripts/derive-truth.ts` and `scripts/verify-case.ts`) stays open and unchanged: those scripts clone over the network and have no seam, and adding one is out of scope for this PR.

**Why:** a pack PR's case data comes from a contributor, so the checks that hold it to the add-only and allowlist rules should pass before git sees it. The schema and the fetch's own re-check already refuse option-shaped values, and the step order adds a second layer behind them. A stack trace hid which case was bad. A named line with the folder tells the contributor what to fix, and matches the `refused` outcome's `case_record_invalid` line.

**Alternatives:** catching in `fetchAll` alone, without a typed error, which could not name the folder; a second loader in `caseCommits.ts` with `safeParse`, which would duplicate `loadCases`; skipping a bad case and fetching the rest, which could let a run go ahead without a case it should have scored.

**What would change it:** a check that needs the case checkouts to vet case data, which would have to run after the fetch.
