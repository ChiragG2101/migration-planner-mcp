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
- `scripts/check-core-untouched.ts` (M10) is an allowlist. A pack PR may change only its knowledge and pack folders, one new usage adapter and its registry line, eval data, tests, docs, and the outputs its build and eval regenerate (`plugin/**`, `eval/history/`, `eval/seeded/recall.md`, its entry in `eval/seeded/ratchet.json`). The drift check guards `plugin/**` and `recall.md`. The ratchet check refuses a lowered entry, a new entry must equal the recall the seeded tier measures, and another pack's entry may not change. Under `eval/history/`, files may only be added, never changed or deleted.
- **Pack PR and core PR.** A *pack PR* is a PR that changes anything under `packs/` or `knowledge/`. A *core PR* is any other PR: one that changes nothing under `packs/` or `knowledge/`. These are the machine definitions, used by every check and document.
- **Eval data in a pack PR.** A case's pack is the `pack` field of its `case.json`. A pack PR may add new case folders for its own pack, and complete its own pack's cases that have no recorded runs on the base branch (such as the Django cases M0 committed with only `case.json`). Completing a case may add files and may change only `notes` and `checks` in `case.json`; the pinned fields (`id`, `pack`, `repo_url`, `base_commit`, `merge_commit`, `pr_url`, `source`, `target`, `tags`, `license`) stay byte-identical. The PR may add the recorded runs, engine and baseline, for those new or completed cases only, and may add (never edit or delete) a line for each new case in the coverage matrix in `eval/cases/README.md`. It may not add, complete or record runs for another pack's case.
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
- **Replay re-runs the engine.** Replay rebuilds each engine run on HEAD's deterministic engine: it applies the recorded ingest arguments and scope answers, re-registers every recorded doc itself with no network (no Context7), and feeds the recorded rounds' lens submissions in order through `find_usages`, the packets (to match usage IDs and snippet hashes), `merge_findings` and the gates, with no new agent turns. Replay stops at the first round HEAD's gates pass, as the live flow does, and scores that plan; later recorded rounds are not fed. A failure that HEAD's gates newly raise, with no recorded round left, goes to `unresolved` and is scored, never patched. Replay keeps each recorded run's size and lens set and does not re-run sizing; if HEAD would size the case differently, the report flags the run, and new live runs measure the change. It scores the result and never calls a model, so knowledge and engine changes show up without new runs. A recorded usage ID is matched to HEAD's usage by its recorded file, span and `snippet_hash`, so renumbered IDs change nothing; a recorded finding with no matching HEAD usage is dropped and counts as a miss, and the report lists those. Truth usages are matched the same way, and `truth.json` is never re-derived for an existing case. Baseline runs are re-scored from their recorded Markdown, since there is no engine to re-run.
- **When HEAD rejects a recorded input.** Replay handles it as the live flow would and flags the run. A recorded scope answer HEAD no longer offers takes the default. A recorded submission that HEAD's `submit_findings` rejects counts as that lens's invalid output under the retry policy, using the recorded retry attempts if there are any, and then `lens.gap`. A recorded doc that HEAD's version pin refuses is not registered.
- **`results.md` is a pure function of HEAD's tree.** It holds no generation time, takes cost and wall time from the recorded runs, and records the engine by its package version, so the same tree always gives the same bytes. It always reports each pack's beat result over all its cases, which needs only HEAD, and renders `eval/cases/REMOVED.json` (D15). Verdicts that depend on the base branch (the regression check's pass or fail, a skipped regression check, the enforced or reported widening beat result) go in the CI job output, never in `results.md`.
- **Case commits.** Eval tooling fetches each case's pinned commits, outside the engine, and CI caches them. When a pinned commit can't be fetched and isn't cached, the gate fails closed with a named error (`case_commit_unavailable`), never skipping the case. The remedy is `npm run cases:verify` and replacing the case through the case-removal path (D15, exception b).
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
