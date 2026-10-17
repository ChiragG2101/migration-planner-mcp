---
name: add-pack
description: Use when adding a new migration pack, or a new major version range to an existing pack, under rules/. It walks the contribution path from rules.json to eval results without touching the engine core.
---

# Add a migration pack

A pack is data plus one usage adapter. If adding it needs an engine change, that is a design bug, fixed in a separate core PR first (see `docs/plans/10-*`, "No core changes").

## 0. Before you start

- Packs only come from the repo's own `rules/` folder; third-party packs are not supported in v0.1.
- Check demand: open an issue with the pack-request template, including evidence that people actually do this migration (for example merged PR counts or survey data).
- Check the language is supported by an existing adapter in `src/lang/` (TS/JS and Python in v0.1). A new language is a core change, not a pack.
- Read `docs/plans/03-*` (pack schema, generator, lint) and `docs/plans/10-*` (how the Django pack was added).

## 1. Pick the shape

- `kind: upgrade` for the same library across versions (Next.js 15 → 16), or `kind: swap` for one library to another (Jest → Vitest).
- `staging: leaf_first` (code first, leaves before importers) or `config_first` (settings first).
- Fix the `from` and `to` ranges against the **current** official release notes, and record the date in `CHANGELOG.md`.

## 2. Write the rules from the docs, not from memory

For every breaking change in the range:

1. Find it in the official upgrade guide or release notes, through Context7 or the docs site.
2. Add a rule to `rules/<pack>/rules.json`: `id`, `usage_kinds`, `concern`, `default_severity`, `mapping`, `no_equivalent` if there is none, `doc_hints` (library and topic, not URLs), `verify_hint` and `rollback_hint`.
3. If an official codemod covers it, reference the codemod by its registry ID in `codemods[]`, and list the rules it covers. If the codemod is not in `src/verify/codemods.ts`, adding it is a core change: a separate PR, with an exact pinned version.

Never put commands, scripts or shell snippets in a pack. Only `verify_hint` and `checks_hint` may look like commands, and they are display text.

## 3. Usage adapter

- Add `src/analysis/usages/<pack>.ts` implementing `UsageAdapter`, and register it with **one line** in `src/analysis/usages/index.ts`.
- Map every usage kind to a lens in the pack's `usage_kinds[] {kind, lens}`.
- Label anything found by name only, not by resolved import, as `confidence: heuristic`.
- Unit-test each usage kind with a small inline fixture (use the `write-tests` skill).

## 4. Generate and lint

- Run the pack generator to produce `SKILL.md` and `references/`. Never edit generated files by hand.
- The skill's trigger is one sentence: "Use when planning a <migration> in a <language> repo." No broad phrases.
- Run the pack lint. It must pass: trigger, line limit, references, codemod IDs, version bump, changelog, and no non-data files.

## 5. Eval

- Seeded repo `eval/seeded/<pack>-tricky/`, with planted hard cases and `ground_truth.json`. Report recall with the recall script and record the ratchet.
- At least **2 golden cases** from real public PRs (use the `add-golden-case` skill), with `checks` declared so L1 can run on at least one.
- Run the eval for the new pack and for every existing pack. The new pack must beat the baseline on recall, and existing packs must not regress beyond the recorded noise band.

## 6. Open the PR

- The `check-core-untouched` check must pass.
- The PR description lists the rules with doc links, the codemods used, and the eval table, with the misses.
- Disclose AI assistance as `AI_POLICY.md` asks.
