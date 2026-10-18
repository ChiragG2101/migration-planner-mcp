# AI policy

This project is built with coding agents, and it is honest about that. This file states how agents are used, what they may and may not do, and how their work is attributed. It sits alongside [`CONTRIBUTING.md`](CONTRIBUTING.md) and defers to [`AGENTS.md`](AGENTS.md) for the project's rules; it does not restate them.

## Stance: agents assist, humans are accountable

Agents draft; a human decides and is accountable. For every contribution, a named human owns the result: its correctness, its security constraints (C1-C10 in [`AGENTS.md`](AGENTS.md)), and the honesty of its report. "An agent wrote it" is never an excuse for a weakened constraint, a loosened test or an unrun gate.

## Co-Authored-By trailers

AI co-author trailers are **optional** — contributor's choice. They are transparency, not attribution of accountability. Whether or not a trailer is present, the human committer is the accountable author of the commit.

If you include an AI co-author trailer, use the canonical form for the agent, as the last trailer(s) in the commit message, after the human sign-off:

```
Signed-off-by: Your Name <your.email@example.com>
Co-Authored-By: Claude <noreply@anthropic.com>
```

Canonical identities (use the matching one; keep the format exact so history stays consistent):

```
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Cursor <noreply@cursor.com>
Co-Authored-By: Codex <noreply@openai.com>
Co-Authored-By: Copilot <noreply@github.com>
Co-Authored-By: Gemini <noreply@google.com>
```

Rules:

- The trailer never replaces the human `Signed-off-by`. The DCO sign-off is always the human (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
- A commit without an AI trailer is not a claim that no agent was involved. Transparency about AI involvement is captured in the PR, below — not inferred from the presence or absence of a trailer.
- If an agent adds a trailer automatically, leave it or remove it as you prefer; either is fine, as long as the sign-off is yours and the format above is used when present.

## Disclosure in the pull request

Because review happens at the PR, that is where AI involvement is disclosed. Include a short **AI assistance** line in the PR description, choosing one level:

- **none** — no agent involvement.
- **assisted** — an agent helped (suggestions, drafting, review), but you wrote or substantially shaped the change.
- **substantial** — an agent produced most of the change; you directed, verified and are accountable for it.

This single line is the project's transparency record. It is deliberately lightweight so it is actually filled in.

## What agents may and may not do

Agents **may**: draft code, tests, docs and plans; propose designs; search and summarize; run the repo's own `npm` scripts; and prepare a milestone for review.

Agents **must not**:

- Weaken, skip, delete or loosen a constraint, a gate or a test, or lower a threshold, to make something pass. Raise it with the maintainer instead (see [`AGENTS.md`](AGENTS.md), "Working rules").
- Review their own milestone. The builder does not review; a fresh, independent session runs [`review-milestone`](.agents/skills/review-milestone/SKILL.md).
- Fabricate or assume results. Never report a gate as passed without running it; if a command does not exist yet, say so plainly.
- Invent commands or files the plans do not describe, or scope-creep beyond the milestone.

## Secrets and data

Agents operate under the repo's security constraints in [`AGENTS.md`](AGENTS.md): reads go through the path boundary, deny-listed files (`.env*`, keys, `.npmrc`, `.pypirc`, and so on) are never read, and the user's repo is never written. No repository contents are sent to external services. The one allowed outbound call is the engine's own narrow Context7 payload (library names, versions and symbols only, never repo contents), and only when configured. There is no telemetry.

## Provenance

The DCO sign-off (see [`CONTRIBUTING.md`](CONTRIBUTING.md)) applies to every contribution regardless of AI involvement. By signing off, the human certifies they have the right to submit the contribution under Apache-2.0, including any AI-assisted output in it. There is no CLA.
