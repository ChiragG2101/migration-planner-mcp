# Contributing

Thanks for your interest in this project. It is a local-first migration engine plus migration packs, licensed under Apache-2.0. This file covers how to contribute; the project's actual rules for building it live in [`AGENTS.md`](AGENTS.md), which this file points to rather than repeats.

## Project state

Pre-code: M0 (spine docs and golden cases) is done, and code starts at M1. There is no `package.json` or test setup yet. The sources of truth are:

- [`docs/PRD.md`](docs/PRD.md) — the product requirements and build spec.
- [`docs/plans/00-overview.md`](docs/plans/00-overview.md) — the cross-cutting constraints (C1-C10), tech decisions, per-milestone gates, cut order and target layout.
- [`docs/plans/01-...`](docs/plans/) to `10-...` — one plan per milestone (M1-M10). M0 and M11 live in the overview.

## How work is organized

Work happens one milestone at a time. Before you start a milestone:

1. Read its plan file in [`docs/plans/`](docs/plans/) in full, plus the overview.
2. Stay inside the milestone's **Scope**. Extras go in a "noticed, not done" list for the maintainer, not in the diff.
3. If you build with an agent, follow the [`implement-milestone`](.agents/skills/implement-milestone/SKILL.md) skill. Don't invent commands or files the plans don't describe.

## Working agreement

These are the non-negotiables, stated in full in [`AGENTS.md`](AGENTS.md) ("Working rules for agents" and "Non-negotiable constraints"). They apply to every change, whether written by a human or an agent:

- **Work from the plan.** The milestone plan is the contract.
- **Ask instead of guessing** when the plan, a constraint or the intent is unclear. Decisions you make go in `docs/design.md`.
- **Never weaken a constraint, a gate or a test to make something pass.** No skipped, deleted or loosened tests, no lowered thresholds. Raise it with the maintainer instead.
- **Tests come with the code.** Every guard gets a test that fails when the guard is removed.
- **Report honestly.** Say what you ran and what it printed. Never call a gate passed without running it.
- **Keep the docs in step.** Update the spine docs in the same change.
- **Independent review.** Whoever builds a milestone does not review it; the review runs in a fresh session.

## Agents and skills

This repo is built with coding agents, and the instructions are tool-neutral. Any agent (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, and others) reads [`AGENTS.md`](AGENTS.md); there is deliberately no `CLAUDE.md`.

- Contributor skills live in [`.agents/skills/`](.agents/skills/), the canonical home. See [`.agents/README.md`](.agents/README.md) for which tool reads what.
- Claude Code users run `scripts/link-agent-skills.sh` once, and again after pulling new skills, to symlink `.claude/skills/<name>` into `.agents/skills/`.
- See [`AI_POLICY.md`](AI_POLICY.md) for how AI assistance is attributed and what agents may and may not do.

## Commits and provenance

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org) (DCO). Add the sign-off with:

```
git commit -s
```

This appends a trailer to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off you certify the DCO: that you wrote the contribution or otherwise have the right to submit it under the project's Apache-2.0 licence. This holds whether or not an agent helped write the change — the human committer is the accountable author. There is no CLA; the sign-off is all that is required.

Keep commits coherent and scoped: one logical step per commit, with a clear message. For AI co-authorship (`Co-Authored-By`), see [`AI_POLICY.md`](AI_POLICY.md).

## Submitting a pull request

1. Work on a branch.
2. Keep the diff inside the current milestone's scope. Put useful extras in a "noticed, not done" list in the PR description.
3. Make sure every commit is signed off (`git commit -s`).
4. Meet the milestone's Definition of Done (see [`AGENTS.md`](AGENTS.md), "Definition of done per milestone"): tests pass including `test/permissions/`, typecheck and lint pass, the eval smoke set passes, the target-repo hash is unchanged, and the spine docs are updated. If a command does not exist yet, say so plainly rather than claiming a gate passed.
5. Include a short **AI assistance** note in the PR description (see [`AI_POLICY.md`](AI_POLICY.md)).

## Reviews

The person (or agent) who builds a milestone does not review it. An independent reviewer runs the [`review-milestone`](.agents/skills/review-milestone/SKILL.md) skill in a fresh session, checking the diff against the milestone plan only. The reviewer must not see the builder's reasoning.
