# M5 dry run

This run was scripted. A driver called the engine API. No host (Cursor or Claude Code) followed `plan_migration` v1 one lens per turn. The event log for run `01M5B2X8AB33MV1N77SCCVZCAT` is the evidence of what the engine did: `scan_repo`, `find_usages`, `get_rule_pack`, `assess_risk`, `propose_scope`, `set_scope`, then the four `get_lens_packet` calls, then the docs queries, then `submit_findings`.

Case `nextjs-bigcommerce-subscription-foundation-51` (MIT). The clone of https://github.com/bigcommerce/subscription-foundation at `6cff8058d722b751cca4961230e8f09af803a88a` stays outside this repo. Source next 14.2.35, target 15.5.21. Context7 was unset, so each docs query used the offline fallback. The repo hash was the same before and after.

## Tool results

`propose_scope` returned size `full` and no questions. `set_scope` with no answers kept that size and excluded nothing. `assess_risk` returned 92 signals.

| Lens | Usages | Rules | Symbols | Truncated |
| --- | --- | --- | --- | --- |
| api | 37 | 12 | 24 | no |
| dependency_build | 43 | 4 | 8 | no |
| behavior_runtime | 0 | 9 | 18 | no |
| verification | 12 | 0 | 0 | no |

`get_migration_docs` was called for all 50 distinct packet symbols. None were refused.

## Submissions

Each lens was accepted on the first attempt (`retry: false`).

- **api**, 3 findings. Codemod `types-react-codemod:preset-19` for the 35 global `JSX` usages. Codemod `types-react-codemod:refobject-defaults` for `useRef()` with no argument in `src/components/Products/Panes/ListPane.tsx`. A manual finding for the private import `next/dist/server/api-utils`.
- **dependency_build**, 3 findings and 4 marks. Bump `next` to 15.5.21. `next-intl@2.14.6` peers Next only through 13 (`next/react-19`; this repo is the Pages Router). Align `@next/eslint-plugin-next`, `eslint-config-next` and `@types/react`. Out of scope, written by this lens: the three `i18n` keys in `next.config.js`, and the `next lint` script. Other lockfile peer rows are left for gate 2 in M6.
- **behavior_runtime**, nothing stored. The packet bound no usage, so the submission was empty.
- **verification**, 1 finding, on the twelve unresolved dynamic locale imports.

`findings.json` is a shortened copy of those stored rows: 7 findings, each with a usage id, and the 4 marks. The full rows are in the run's database.

---

# M5 dry run — host-agent run (Cursor)

This run was executed by the host agent (Cursor, `databricks-claude-sonnet-4-6`) following `plan_migration.v1.md` one lens per turn in a single Node.js process. The engine was called through its programmatic API (`src/core/index.ts`). No scripted driver authored the findings; the host read each packet and authored findings from the evidence.

**Repo:** `tortoise-web-frontend/apps/employer-dashboard` (private, on the user's Desktop). Next.js 14.2.35 (App Router, pnpm workspace). Source next 14.2.35, target next 15. Context7 was unset. The original repo was never written; a read-only mirror was created in `/tmp` with the workspace-level `pnpm-lock.yaml` copied in so the engine could resolve the installed version (the lockfile lives at the workspace root, not inside the app folder — a pnpm workspace limitation noted below). The original repo hash `e3a6d07cf00edfe38aa3aa0605df543fa47ae82a054b824dd45c14f98b8f0891` was unchanged after the run.

**Workspace limitation noted:** The engine's file walk is bounded to 256 MB total. Scanning the full workspace root hit this limit before reading the 664 KB `pnpm-lock.yaml` (the six apps' source files consumed the budget). Workaround: mirror the single app with the lockfile at the correct relative path. This is a known limitation for large pnpm workspaces; a future `--workspace-root` flag could address it without raising the byte limit.

## Tool results

`propose_scope` returned size `full` (reasons: 7 peer dependency conflicts, 9 usages match a composed rule, a matched usage is high or blocker). No questions. `set_scope` with no answers kept the defaults.

| Lens | Usages | Rules | Symbols | Truncated |
| --- | --- | --- | --- | --- |
| api | 11 | 13 | 26 | no |
| dependency_build | 136 | 3 | 6 | yes (544 peer_dependency usages truncated) |
| behavior_runtime | 2 | 9 | 18 | no |
| verification | 0 | 0 | 0 | no |

Key usages found:
- **api**: 6 `request_props/params` in dynamic route pages (billing, employee import), 2 `request_api/next/headers.headers` in `layout.jsx`, 1 `middleware`, 1 `react_legacy`, 1 `request_props/searchParams`
- **dependency_build**: 8 `config_key` (next.config.js), 1 `next_lint_script`, 7 `dependency`, 664 `peer_dependency` (truncated to 120 in packet)
- **behavior_runtime**: 2 `fetch_call` (both already use `{ cache: 'no-store' }`)
- **verification**: no usages (no test runner configured)

## Submissions

Each lens was accepted on the first attempt (`retry: false`, `gap: false`).

- **api**, 2 findings, 2 marks.
  - Codemod `next-codemod:next-async-request-api` for 6 `params` usages in dynamic route pages (`api-async-params`, high).
  - Codemod `next-codemod:next-async-request-api` for 2 `headers()` calls in `layout.jsx` (`api-async-headers`, high).
  - Out of scope: `middleware` (unchanged in 15, rename is a 16 change), `react_legacy` usage (no reviewed rule in 14→15 range).
- **dependency_build**, 2 findings, 134 marks.
  - Manual: bump `next` to 15.x (`dep-next-bump`, high).
  - Manual: replace `images.domains` with `images.remotePatterns` in next.config.js (`dep-images-domains-deprecated`, medium).
  - Out of scope: all other config keys, lint script, peer_dependency rows, non-next dependencies.
- **behavior_runtime**, nothing stored. Both `fetch_call` usages already use `{ cache: 'no-store' }`, which is the Next.js 15 default — marked out of scope.
- **verification**, nothing stored. No test runner configured; the packet was empty.

Run ID: `01M5B4R7E5HVFQRQ1HB8WMEA6C`. The full event log is in the run's SQLite store at `/tmp/mp-tortoise-dry-run5/store.sqlite` (not committed; ephemeral).
