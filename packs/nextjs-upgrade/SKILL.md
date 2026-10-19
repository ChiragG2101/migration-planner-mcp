---
name: nextjs-upgrade
description: Use when planning a Next.js major version upgrade in a TypeScript or JavaScript repo.
---

<!-- do not edit; generated from pack v0.3.0 -->

# nextjs-upgrade

Plan the migration with the engine, in this order. The engine is read-only at level 0.

1. `scan_repo`
2. `find_usages`
3. `get_rule_pack`
4. `assess_risk`
5. `propose_scope`
6. ask the user, then `set_scope`
7. `plan_migration` for each lens, which registers its docs with `get_migration_docs`
8. `merge_findings`
9. `validate_plan`
10. `emit_plan`
11. at level 1 only, `verify_stage`

A finding follows the finding schema. Do not inline API tables; read the references.

Checked range: 14 to 16. Staging: leaf_first.

- [14](references/14.md)
- [15](references/15.md)
- [16](references/16.md)
- [react changes](references/react-changes.md)
- [codemods](references/codemods.md)
