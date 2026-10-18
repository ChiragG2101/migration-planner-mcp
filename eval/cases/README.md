# Golden cases

Each golden case is a real, public, merged migration PR used as ground truth. The planner runs on the **base commit** (the commit before the PR) and its output is scored against what the PR actually changed. One directory per case holds a `case.json` (the record) and, from M7 on, a generated `truth.json` (never hand-edited; see the `add-golden-case` skill and `docs/plans/07-*`).

Checkouts happen in the gitignored eval workspace (`eval/.work/`), never in the engine's view of a user repo. `truth.json` is **not** derived in M0; M0 only pins base commits that can be checked out (overview §M0 acceptance). Each row's `base_commit` is the first parent of the merge commit for a squash/merge commit, or the sole parent for a non-merge commit.

## Next.js pack (`nextjs-upgrade`)

| Case | Repo | From → to | Base commit | PR | Licence | Tags |
| --- | --- | --- | --- | --- | --- | --- |
| `nextjs-bigcommerce-subscription-foundation-51` | bigcommerce/subscription-foundation | next 14.2.35 → 15.5.21 | `6cff8058` | [#51](https://github.com/bigcommerce/subscription-foundation/pull/51) | MIT | l1-candidate, jest, prisma |
| `nextjs-neotree-editor-165` | neotree/neotree-editor | next 14.2.35 → 15.5.27 | `1f15f5c1` | [#165](https://github.com/neotree/neotree-editor/pull/165) | MIT | l1-candidate, tsx-tests, drizzle |
| `nextjs-chiarel-6-messy` | shams96/chiarel | next 14.2.35 → 15.5.27 | `aa6727ee` | [#6](https://github.com/shams96/chiarel/pull/6) | **none** | messy, reverted-and-retried, license-blocker, needs-review |

## Django pack (`django-upgrade`)

| Case | Repo | From → to | Base commit | PR | Licence | Tags |
| --- | --- | --- | --- | --- | --- | --- |
| `django-ror-api-548` | ror-community/ror-api | django 3.2.25 → 4.2.30 (LTS→LTS) | `3ba4a12c` | [#548](https://github.com/ror-community/ror-api/pull/548) | MIT | l1-candidate, lts-to-lts, clean |
| `django-thunderstore-1369` | thunderstore-io/Thunderstore | django 3.1.7 → 4.2.30 (→LTS) | `43873ef2` | [#1369](https://github.com/thunderstore-io/Thunderstore/pull/1369) | AGPL-3.0 | l1-candidate, to-lts, larger-surface, monorepo-ish |

## Status against the M0 target

- Next.js: **3 candidates** (target by M7 is 5–8). One messy case present (`chiarel`), as required.
- Django: **2 candidates** (M0 minimum met). Both land on the 4.2 LTS and have runnable test suites, but only **one is a true LTS→LTS** (`ror-api`, 3.2→4.2). `thunderstore` is 3.1→4.2, i.e. upgrade *to* an LTS from a non-LTS release, since Django 3.1 is not LTS. See the open item below and `docs/design.md` (D4).

## Open items (noticed, not done in M0)

- **`chiarel` has no OSS licence** → fails the `add-golden-case` licence check. It is kept as the messy candidate but is a **blocker for M7**: replace it with a licensed reverted/partial Next.js upgrade, or get the owner to add a licence, before any clone or published truth. Finding a well-licensed messy upgrade is the hard part the PRD §15 risk warns about.
- **Only one true LTS→LTS Django case.** Task 6 asks for ≥2 Django LTS-to-LTS upgrades. `ror-api` (3.2→4.2) is a genuine LTS→LTS; `thunderstore` is 3.1→4.2 (upgrade *to* an LTS, since 3.1 is not LTS). `docs/design.md` (D4) records that landing on an LTS boundary qualifies a case for M0, so the ≥2 Django minimum is met in spirit, but **before M7/M10** add a second genuine LTS→LTS case (another 3.2→4.2, or a 4.2→5.2) so the pack is anchored on real LTS→LTS surface.
- **No messy Django case yet.** The overview's M0 only requires ≥2 Django with runnable tests (met). The `add-golden-case` skill wants ≥1 messy per pack; `thunderstore-1369` is the larger/noisier of the two but is not a revert. Add a reverted/partial Django upgrade before M10 locks the Django pack's scope.
- **Grow Next.js to 5–8 by M7**, preferring repos with CI and tests, and ideally some monorepos (next-usage recall is the point of M2).
- **L1 service needs:** several cases need a database or other services for their checks (ror-api: MySQL 8.4 and Elasticsearch 7.10; thunderstore: Postgres, Redis, RabbitMQ and MinIO through `docker/docker-compose.pytest.yml`; bigcommerce: Prisma migrate on build; neotree: Drizzle). These are the user's declared checks and are reported, not hidden (PRD §7A); confirm exact service setup from each repo's CI before enabling L1 in M8.
