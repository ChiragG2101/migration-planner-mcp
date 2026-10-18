# .agents

Tool-neutral home for agent assets that contributors share. Nothing in here is specific to one coding agent.

## Layout

```
.agents/
  skills/<skill-name>/SKILL.md     # contributor skills (Agent Skills format, https://agentskills.io)
```

Project instructions live in `/AGENTS.md`, not here.

These are **contributor skills**: they help agents build this repo (implement a milestone, review one, add a pack). **Product skills**, the ones users of the engine get, are generated from `packs/<pack>/pack.json` plus the library knowledge under `knowledge/`, and are not stored here.

## Which tools read what

| Tool | Instructions | Skills |
| --- | --- | --- |
| Codex, Cursor, GitHub Copilot, Gemini CLI | `AGENTS.md` | `.agents/skills/` |
| Claude Code (v2.1.277 or later) | `AGENTS.md`, read directly because the repo has no `CLAUDE.md` | `.claude/skills/` only. `scripts/link-agent-skills.sh` creates a symlink there for each skill in `.agents/skills/` |

On Claude Code older than v2.1.277, create an untracked `CLAUDE.local.md` containing `@AGENTS.md`.

## Rules for skills

- The source of truth is `.agents/skills/<name>/`. Never edit a copy elsewhere.
- `scripts/check-agent-skills.sh` enforces the rules below (portable frontmatter, matching name, "Use when" trigger, length, no scripts).
- Use only portable frontmatter fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
- The `description` is a narrow trigger sentence that starts with "Use when".
- Keep skills short (about 100 lines; the check fails over 120), and put deeper material in files next to `SKILL.md`.
- No scripts that run on their own. A skill may tell an agent to run the repo's own `npm` scripts.
- `.claude/` is gitignored as a whole. Claude Code users run `scripts/link-agent-skills.sh`, which creates `.claude/skills/<name>` symlinks into `.agents/skills/`. The script is idempotent and safe to rerun after pulling new skills. On Windows it needs Developer Mode for symlinks, or it falls back to copying.

## What stays tool-specific

Settings, permissions and hooks (`.claude/settings*.json`, `.cursor/`, `.codex/`, `.vscode/`) have different formats for each tool, so they are not shared. Tool folders such as `.claude/` and `.vscode/` are gitignored as a whole. Anything a contributor's agent must follow goes in `AGENTS.md` or a skill, never only in one tool's settings.
