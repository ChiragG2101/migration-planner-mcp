---
name: add-release-knowledge
description: Use when adding or correcting the rules for one library release under knowledge/ (for example Next.js 16 or Django 5.2). It covers drafting from the official notes, completing each rule, seeding it and getting it reviewed.
---

# Add release knowledge

Knowledge is the engine's list of facts about a library, one file per release (`docs/design.md` D10, `docs/plans/03-*`). A wrong rule makes every plan built on it wrong, so draft from the official notes, never from memory.

## 0. Before you start

- Find the library under `knowledge/<ecosystem>/<library>/`. A new library needs a `library.json` first: version scheme, release unit, `lts[]` if any, `covered_from`, `doc_sources`, `release_notes` and codemods. If its version scheme or a match kind it needs is missing, that is a core change: raise it, don't work around it.
- One release per PR keeps review possible.
- Pre-releases (canary, rc, beta) are not supported. Wait for the final release.

## 1. Draft

- Run `npm run knowledge:draft -- <library> <release>`. It fetches the official notes and writes `draft` rules with a title, a `source` link and a guessed `event`. It never overwrites a reviewed rule.
- If the parser reports an unknown section, read that section yourself. Don't guess.

## 2. Complete each draft

For each draft, read its `source` section in full, then fill in:

- `event` (`deprecated`, `removed`, `changed_behavior`, `changed_default`, `renamed`, `peer_requirement`) and a finer `version` if it happened in a patch release
- `replacement_since`: the release in which the new form first existed, if there is one. It decides whether the fix can land before the upgrade, so check it in the older release's notes.
- `match`, using a typed match kind. If the change is about something already defined in an earlier release, add an `events[]` entry here instead of a new rule.
- `concern`, `default_severity`, `mapping`, `no_equivalent`, `codemod` (only an ID the library lists), `doc_topics`, `verify_hint`, `rollback_hint`, `notes`
- For a `peer_requirement` rule only: `requires {library, range}`, the companion and the range the primary needs. Its `match` says where the requirement applies.
- Do not set `necessity` or `lands_on`. The engine derives both per run.

Never put commands, scripts or shell snippets in a rule. `verify_hint` and `rollback_hint` are display text only.

## 3. Seed it

For every rule a pack can reach, plant at least one `expect: change` case in the seeded repo that pack names in its `seeded` field (`eval/seeded/<name>/`), with its `rule_id`. Code-usage kinds also need an indirect case (through a helper, wrapper or re-export). Use the `write-tests` skill.

## 4. Check

- `npm run lint` (the pack lint) and `npm run build:packs` must pass, with no generated-file drift.
- Run `npm run pack:report -- <pack>` for each pack that uses the library. Every "missing" item is either added as a rule or explained in the PR. "Stale" links get fixed.
- Run the eval for each affected pack (the regression rule).

## 5. Review

- A second person, or a fresh agent session, reads each rule against its `source` and flips `status` to `reviewed`. The author does not review their own rules.
- Add an entry to the library's `CHANGELOG.md`, and bump the version of each pack that uses it.
- The PR description lists the rules with their source links and attaches the pack update report.
