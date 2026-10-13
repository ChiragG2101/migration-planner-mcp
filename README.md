# migration-planner-mcp

**Status: currently building. Planning stage only; there is no code yet.**

A local-first MCP server that reads a TypeScript/JavaScript codebase plus a migration target (Express to Hono first, then Jest to Vitest) and returns a staged plan. Every step in the plan cites code and docs and carries a risk rating, a rollback note and a verification check. The plan is checked by deterministic gates, not by another LLM.

Design constraints: it runs locally over stdio and costs nothing to host. Storage is SQLite plus plain files. It is read-only against the target repo, and that is enforced in code. It never executes the target repo's scripts.

## Docs

- [`docs/PRD.md`](docs/PRD.md): the product requirements and build spec (v3).
- [`docs/plans/00-overview.md`](docs/plans/00-overview.md): the implementation plan overview, cross-cutting rules and milestone map.
- `docs/plans/01-...` to `09-...`: one plan per milestone, M1 to M9.

M0 (spine docs and golden-case selection) and M10 (publishing) are covered in the overview.
