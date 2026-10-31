# Golden cases

Each golden case is a real, public, merged migration PR used as ground truth. The planner runs on the **base commit** (the commit before the PR) and its output is scored against what the PR actually changed. One directory per case holds a `case.json` (the record) and, from M7 on, a generated `truth.json` (never hand-edited; see the `add-golden-case` skill and `docs/plans/07-*`).

Checkouts happen in the gitignored eval workspace (`eval/.work/`), never in the engine's view of a user repo. `truth.json` is **not** derived in M0; M0 only pins base commits that can be checked out (overview §M0 acceptance). Each row's `base_commit` is the first parent of the merge commit for a squash/merge commit, or the sole parent for a non-merge commit.

## Next.js pack (`nextjs-upgrade`)

| Case | Repo | From → to | Base commit | PR | Licence | Tags |
| --- | --- | --- | --- | --- | --- | --- |
| `nextjs-bigcommerce-subscription-foundation-51` | bigcommerce/subscription-foundation | next 14.2.35 → 15.5.21 | `6cff8058` | [#51](https://github.com/bigcommerce/subscription-foundation/pull/51) | MIT | l1-candidate, jest, prisma |
| `nextjs-neotree-editor-165` | neotree/neotree-editor | next 14.2.35 → 15.5.27 | `1f15f5c1` | [#165](https://github.com/neotree/neotree-editor/pull/165) | MIT | l1-candidate, tsx-tests, drizzle |
| `nextjs-cabinetoffice-gap-find-apply-web-497` | cabinetoffice/gap-find-apply-web | next 13.5.6 → 15.5.23 | `db86ff25` | [#497](https://github.com/cabinetoffice/gap-find-apply-web/pull/497) | MIT | several-major-hops, monorepo, pages-router, cypress |
| `nextjs-couchers-web-9893` | Couchers-org/couchers | next 15.5.7 → 16.4.0 | `b7823292` | [#9893](https://github.com/Couchers-org/couchers/pull/9893) | MIT | pages-router, 15-to-16, jest, monorepo |
| `nextjs-c-shepherd-speller-16` | wdonray/c-shepherd-speller | next 15.4.6 → 16.3.8 | `720be533` | [#16](https://github.com/wdonray/c-shepherd-speller/pull/16) | MIT | 15-to-16, vitest, playwright, app-router, single-package |
| `nextjs-annuaire-entreprises-2146-messy` | annuaire-entreprises-data-gouv-fr/site | next 15.3.8 → 16.1.1 | `a31accd7` | [#2146](https://github.com/annuaire-entreprises-data-gouv-fr/site/pull/2146) | MIT | messy, reverted, 15-to-16, app-router, jest, cypress |
| `nextjs-scaffold-move-43` | arjanjohan/scaffold-move | next 14.2.28 → 15.5.27 | `d1e72589` | [#43](https://github.com/arjanjohan/scaffold-move/pull/43) | MIT | monorepo, app-router, 14-to-15, yarn-workspaces |

Removed: `nextjs-chiarel-6-messy` (shams96/chiarel, unlicensed), replaced by `nextjs-annuaire-entreprises-2146-messy`; `nextjs-wazaby-web-137` (no test script and no CI), replaced by `nextjs-couchers-web-9893`. See `eval/cases/REMOVED.json`.

### Coverage matrix (Next.js pack)

| Case | Router | Packages | Major hops | Test runner | Data layer | Real diff (files) |
| --- | --- | --- | --- | --- | --- | --- |
| bigcommerce-51 | app | single | 1 (14→15) | jest | prisma | small (4, mostly lockfile) |
| neotree-165 | app | single | 1 (14→15) | tsx | drizzle | medium |
| cabinetoffice-497 | pages | monorepo (admin+applicant) | **2 (13→14→15)** | cypress | — | small (7) |
| couchers-9893 | **pages (only)** | monorepo (web app) | 1 (**15→16**) | **jest** | — | small (8) |
| c-shepherd-speller-16 | app | single | 1 (**15→16**) | **vitest + playwright** | — | medium (8) |
| annuaire-2146-messy | app | single | 1 (**15→16**, **reverted**) | jest + cypress | — | large (63) |
| scaffold-move-43 | app | **monorepo (yarn workspaces)** | 1 (14→15) | — | move/aptos | small (3) |

## Django pack (`django-upgrade`)

| Case | Repo | From → to | Base commit | PR | Licence | Tags |
| --- | --- | --- | --- | --- | --- | --- |
| `django-ror-api-548` | ror-community/ror-api | django 3.2.25 → 4.2.30 (LTS→LTS) | `3ba4a12c` | [#548](https://github.com/ror-community/ror-api/pull/548) | MIT | l1-candidate, lts-to-lts, clean |
| `django-thunderstore-1369` | thunderstore-io/Thunderstore | django 3.1.7 → 4.2.30 (→LTS) | `43873ef2` | [#1369](https://github.com/thunderstore-io/Thunderstore/pull/1369) | AGPL-3.0 | l1-candidate, to-lts, larger-surface, monorepo-ish |

## Status against the M0 target

- Next.js: **7 cases** (target by M7 is 5–8). One messy case present (`annuaire-2146-messy`, a licensed upgrade→revert saga), as required. Every case carries an open licence (MIT or Apache-2.0); the unlicensed `chiarel` was removed (`REMOVED.json`).
- Django: **2 candidates** (M0 minimum met). Both land on the 4.2 LTS and have runnable test suites, but only **one is a true LTS→LTS** (`ror-api`, 3.2→4.2). `thunderstore` is 3.1→4.2, i.e. upgrade *to* an LTS from a non-LTS release, since Django 3.1 is not LTS. See the open item below and `docs/design.md` (D4).

## Open items (noticed, not done in M0)

- **`chiarel` has no OSS licence** → resolved in the M7 live handover. It was removed under D15 exception (b) with a `REMOVED.json` entry (it was a pending case, no recorded runs) and replaced by `nextjs-annuaire-entreprises-2146-messy` (annuaire-entreprises-data-gouv-fr/site PR #2146, MIT, next 15.3.8 → 16.1.1), a real merged upgrade that was reverted the next day — the licensed equivalent of the chiarel upgrade→revert shape.
- **Only one true LTS→LTS Django case.** Task 6 asks for ≥2 Django LTS-to-LTS upgrades. `ror-api` (3.2→4.2) is a genuine LTS→LTS; `thunderstore` is 3.1→4.2 (upgrade *to* an LTS, since 3.1 is not LTS). `docs/design.md` (D4) records that landing on an LTS boundary qualifies a case for M0, so the ≥2 Django minimum is met in spirit, but **before M7/M10** add a second genuine LTS→LTS case (another 3.2→4.2, or a 4.2→5.2) so the pack is anchored on real LTS→LTS surface. Now an M12 task and acceptance criterion (moved from M10, D60).
- **No messy Django case yet.** The overview's M0 only requires ≥2 Django with runnable tests (met). The `add-golden-case` skill wants ≥1 messy per pack; `thunderstore-1369` is the larger/noisier of the two but is not a revert. Add a reverted/partial Django upgrade before M12 locks the Django pack's scope (moved from M10, D60). Now an M12 task and acceptance criterion.
- **Grow Next.js to 5–8 by M7** — done: 7 cases, picked for spread (a 13→15 multi-hop monorepo, a pages-router-only app with a jest suite, a 15→16 vitest+playwright app, a reverted messy 15→16, and a yarn-workspaces monorepo), each filling a previously empty coverage cell. Note: TAG-IT-NETWORK/tagit-dashboard #63 was considered for the monorepo cell but rejected because its apps mix next 14.2.35 and 16.1.0 at base, so `scan_repo` raises an ambiguous-version question the truth-derivation tooling cannot answer; `scaffold-move` (single next version) was used instead. `nextjs-wazaby-web-137` filled the pages-router cell first and was removed because the base commit has no test script and no CI, so it cannot support the re-checker's test check or M8; `nextjs-couchers-web-9893` is the pages-router replacement and has a jest suite.
- **L1 service needs:** several cases need a database or other services for their checks (ror-api: MySQL 8.4 and Elasticsearch 7.10; thunderstore: Postgres, Redis, RabbitMQ and MinIO through `docker/docker-compose.pytest.yml`; bigcommerce: Prisma migrate on build; neotree: Drizzle). These are the user's declared checks and are reported, not hidden (PRD §7A); confirm exact service setup from each repo's CI before enabling L1 in M8.
