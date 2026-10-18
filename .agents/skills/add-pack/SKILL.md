---
name: add-pack
description: Use when adding a new migration pack under packs/, or widening an existing pack's checked range to a new release. It walks the contribution path from pack.json and knowledge to eval results without touching the engine core.
---

# Add a migration pack

A pack is data plus one usage adapter. The facts live in `knowledge/`, per library and per release; the pack only says which libraries to use and how to plan with them (`docs/design.md` D10). If adding a pack needs an engine change, that is a design bug, fixed in a separate core PR first (see `docs/plans/10-*`, "No core changes").

## 0. Before you start

- Packs only come from the repo's own `packs/` and `knowledge/` folders; third-party packs are not supported in v0.1.
- Check demand: open an issue with the pack-request template, including evidence that people actually do this migration (for example merged PR counts or survey data).
- Check the language is supported by an existing adapter in `src/lang/` (TS/JS and Python in v0.1), and that the version scheme and match kinds you need exist in the core. If not, that is a core change, not a pack.
- Read `docs/plans/03-*` (knowledge and pack schema, composition, generator, lint) and `docs/plans/10-*` (how the Django pack was added).

## 1. Knowledge first

- Every library the pack uses needs knowledge for every release in the range you want to support. Add missing releases with the `add-release-knowledge` skill, one release per PR.
- Widening an existing pack to a new release is mostly this step, plus a `supported` bump.

## 2. Write `packs/<pack>/pack.json`

- `kind: upgrade` for the same library across versions (Next.js 15 → 16), or `kind: swap` for one library to another (Jest → Vitest).
- `libraries[]`: one `primary`, plus `companion` libraries whose range follows from the primary's peer requirements.
- `supported {from, to}`: only releases whose knowledge is reviewed. Record the date in `CHANGELOG.md`.
- `staging: leaf_first` (code first, leaves before importers) or `config_first` (settings first).
- `usage_adapter`, `usage_kinds[] {kind, lens}`, `checks_hint`, `trigger`.
- `seeded`: the name of the pack's seeded repo under `eval/seeded/` (for example `next-tricky`).

Never put commands, scripts or shell snippets in a pack. Only `checks_hint` may look like a command, and it is display text.

## 3. Usage adapter

- Add `src/analysis/usages/<pack>.ts` implementing `UsageAdapter`, declare its `match_kinds[]`, and register it with **one line** in `src/analysis/usages/index.ts`.
- Label anything found by name only, not by resolved import, as `confidence: heuristic`.
- Unit-test each usage kind with a small inline fixture (use the `write-tests` skill).

## 4. Generate and lint

- Run `npm run build:packs` to produce `SKILL.md` and `references/`. Never edit generated files by hand.
- The skill's trigger is one sentence: "Use when planning a <migration> in a <language> repo." No broad phrases.
- Run the pack lint (`npm run lint`). It checks the trigger, line limit, references, codemod IDs, versions and changelogs, the match kinds your adapter declares, seeded coverage of every reachable rule, and that there are no non-data files.

## 5. Eval

- Seeded repo `eval/seeded/<name>/`, the one `pack.json` names in `seeded`, with planted hard cases and `ground_truth.json` (each `expect: change` entry names its `rule_id`). Report recall with the recall script and add the pack's entry to `eval/seeded/ratchet.json`.
- At least **2 golden cases** from real public PRs: find candidates with `npm run cases:find` and vet them with the `add-golden-case` skill. Declare `checks` so L1 can run on at least one.
- Run the eval for the new pack and for every existing pack. The new pack must beat the baseline on recall (`docs/design.md` D17). If it doesn't, the pack isn't ready: raise it with the maintainer rather than tuning the eval or the baseline. Existing packs must not regress beyond the recorded noise band.

## 6. Open the PR

- The `check-core-untouched` check must pass. It allows only the pack's knowledge and pack folders, the adapter and its registry line, eval data, tests, docs and regenerated outputs (see `docs/plans/10-*`).
- Attach the output of `npm run pack:report -- <pack>` and explain every "missing" item.
- The PR description lists the libraries and range, the codemods used, and the eval table, with the misses.
- Disclose AI assistance as `AI_POLICY.md` asks.
