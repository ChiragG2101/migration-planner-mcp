# AGENTS.md snippet

The engine reads only the fenced block under `## migration-planner`.
Everything else in the file is ignored. The heading stays `migration-planner`
until the docs-and-release PR renames it.

`planner_deny` adds globs to the deny list. A glob that starts with `!`, is
absolute, or contains `..` is rejected. `checks` are printed at ingest and
run only when the process is started with `--trust-repo-checks`. `--install`
and `--check` replace them. `targets` is compared with the requested target;
a mismatch is a question, and the request is left as given.

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
