# migration-planner-mcp (working name)

**Status: currently building. Planning stage only; there is no code yet.**

A local-first migration engine for upgrading and migrating codebases. It reads a repo plus a migration target and returns a staged plan. Every step cites code and docs and carries a risk rating, a rollback note and a verification check. The plan is checked by deterministic gates, not by another LLM. With an explicit flag, each stage is also applied and verified in a throwaway sandbox copy of the repo, and handed back as patches you apply yourself.

The engine is general; each migration is a **pack**. The first packs are a **Next.js major upgrade** and a **Django LTS to LTS upgrade**. The engine is used through a CLI, an MCP server (Claude Code, Cursor and other agents) and generated agent skills.

Design constraints: it runs locally and costs nothing to host. Storage is SQLite plus plain files. It never writes to your repo, and that is enforced in code. By default it runs nothing; at `--level 1` it runs only allowlisted codemods and the checks you declare, inside a sandbox copy.

## Docs

- [`docs/PRD.md`](docs/PRD.md): the product requirements and build spec.
- [`docs/plans/00-overview.md`](docs/plans/00-overview.md): the implementation plan overview, cross-cutting rules and milestone map.
- `docs/plans/01-...` to `10-...`: one plan per milestone, M1 to M10.

M0 (spine docs and golden-case selection) and M11 (publishing) are covered in the overview.

## Working on this repo with a coding agent

[`AGENTS.md`](AGENTS.md) holds the project instructions for any agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI). Shared contributor skills live in [`.agents/`](.agents/README.md).
