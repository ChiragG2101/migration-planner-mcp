# AGENTS.md snippet

The engine reads only the fenced block under `## migration-planner`.
Everything else in the file is ignored. The heading stays `migration-planner`
until the docs-and-release PR renames it.

`planner_deny` adds globs to the deny list. A glob that starts with `!`, is
absolute (including a Windows path), contains `..`, is longer than the limit,
or has too many `**` is rejected (D58). One snippet can add only a bounded
number of globs. `checks` are printed at ingest and run only when the process
is started with `--trust-repo-checks`. `--install` and `--check` replace them,
and the first set that is adopted stays frozen. `targets` is compared with
the requested target. A mismatch is a question. `confirm_target: true` (CLI
`--confirm-target`) plans the requested target; the snippet does not change it.

## migration-planner

```yaml
checks:
  install: npm ci
  typecheck: npx tsc --noEmit
  test: npm test
planner_deny:
  - secrets/**
  - "**/*.pem"
targets:
  - next@16
  - django@5.2
```
