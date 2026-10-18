# Milestone checklist

A short, link-only index of the build. The detail lives in [`docs/plans/`](docs/plans/); the constraints, gates and layout are in [`docs/plans/00-overview.md`](docs/plans/00-overview.md); the spec is [`docs/PRD.md`](docs/PRD.md).

A milestone is done only when every per-milestone gate holds (overview, "Per-milestone gates"): `npm test` (incl. `test/permissions/`), `npm run typecheck`, `npm run lint`, the eval smoke set, the target-repo hash unchanged after the demo, an independent review, a comprehension quiz, and the spine docs updated.

| # | Milestone | Plan | Status |
| --- | --- | --- | --- |
| M0 | Spine docs and golden cases (pre-code) | [overview §M0](docs/plans/00-overview.md) | done (review approved 2026-10-18) |
| M1 | Engine skeleton, CLI + MCP adapters, `scan_repo`, event log, path boundary, read-only rule | [01](docs/plans/01-engine-skeleton-scan-repo-permissions.md) | not started |
| M2 | Language adapters (TS, Python), import graphs, `find_usages` (Next.js), usage index | [02](docs/plans/02-language-adapters-find-usages.md) | not started |
| M3 | Knowledge and pack schema, Next.js knowledge and pack, `get_rule_pack`, `assess_risk`, sizing and scope, generated skill, release drafter and pack update report | [03](docs/plans/03-rule-pack-assess-risk-skill.md) | not started |
| M4 | Context7 integration, retrieval log, cache | [04](docs/plans/04-context7-docs-cache.md) | not started |
| M5 | Finding schema, `plan_migration` prompt, four lenses | [05](docs/plans/05-finding-schema-prompt-lenses.md) | not started |
| M6 | `merge_findings`, `validate_plan` gates 1–6, emit | [06](docs/plans/06-merge-findings-validate-plan.md) | not started |
| M7 | Eval runner, 5 Next.js golden cases, baseline run, golden-case finder and re-checker | [07](docs/plans/07-eval-runner-golden-baseline.md) | not started |
| M8 | Sandboxed verify loop (L1), codemod registry, gate 7 (test integrity) | [08](docs/plans/08-sandboxed-verify-loop.md) | not started |
| M9 | Confidence routing, `record_feedback`, run report | [09](docs/plans/09-confidence-feedback-report.md) | not started |
| M10 | Django pack (no core changes), README, open-source files, demo, name decided | [10](docs/plans/10-django-pack-readme-oss-demo.md) | not started |
| M11 | Publish to npm, tag v0.1 | [overview §M11](docs/plans/00-overview.md) | not started |

## Noted for later (not yet planned)

Ideas agreed to be worth building, but not yet given a milestone. Each needs a plan entry before work starts.

- **Upgrade one version at a time.** Some official guides (Django's in particular) advise crossing several releases one at a time. Staging today orders work by file (`leaf_first`, `config_first`) and puts source-compatible fixes before the bump (D5), but it cannot split a multi-release range into one bump per release. It needs a pack option and an M6 staging mode.

M0 deliverables: [`docs/design.md`](docs/design.md), [`docs/invariants.md`](docs/invariants.md), [`docs/failure-modes.md`](docs/failure-modes.md), this file, and the golden cases under [`eval/cases/`](eval/cases/).
