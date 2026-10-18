# Migration Engine - PRD and Build Spec

Status: planning, Oct 18 2026. Nothing is built yet. The working name stays `migration-planner-mcp` until the final name is chosen in M10.

**One line:** a local-first migration engine that reads a codebase plus a migration target (for example a Next.js major upgrade) and returns a staged plan where every step cites code and docs, has a risk rating, a rollback note and a verification check. The plan is checked by a program, not by another LLM opinion. With an explicit flag, each stage is also applied and verified in a throwaway sandbox copy, and the result is handed back as patches.

## 1. Constraints

- **Local-first, zero hosting cost.** Runs on the user's machine. No servers, no paid database. Storage is SQLite and plain files.
- **The user's own model does the writing.** MCP "sampling" is deprecated in the current MCP spec (https://modelcontextprotocol.io/specification/2026-07-28/client/sampling), so the engine does deterministic work and the host agent (Claude Code, Cursor, Codex) is the LLM.
- **Execution only when asked, and only in a sandbox.** L0 (the default) never executes anything. L1 runs only allowlisted codemods and the checks the user declared, inside a sandbox copy of the repo (section 7A).
- **Context7 pairing** for old and new docs (section 9).
- **Honest claims.** Say "currently building" until it ships with real eval numbers.

## 2. Map the mess: how a senior engineer plans a migration today

Remove the AI and write down every micro-decision a human makes, then mark which are mechanical, which are judgment, and where the human fails. For a framework major upgrade such as Next.js:

| Step a human takes | Type | Where humans fail |
| --- | --- | --- |
| Read the manifests, find entrypoints, versions, test setup | Mechanical | Misses monorepo packages, secondary apps, pinned peer versions |
| Capture current behaviour before changing anything (tests, typecheck, build, recorded outputs) | Mechanical | Skips it, so there is nothing to compare against afterwards |
| Run the official codemods | Mechanical | Treats codemod output as finished; does not check what it skipped |
| Find every use of the changed APIs, including indirect ones | Mechanical | Misses wrapped helpers, re-exports, config-driven behaviour |
| Read the upgrade guide and release notes for every version in between | Retrieval | Reads stale docs, skips intermediate versions' breaking changes |
| Spot behaviour changes with no mechanical fix (caching defaults, async APIs, removed settings) | Judgment | Finds them in production |
| Order the work so the build stays green | Judgment | Big-bang upgrade, no rollback point |
| Decide what to test after each step, and check tests were not weakened to pass | Judgment | Tests too late; deletes or skips failing tests |
| Write the plan and get it reviewed | Writing | Plan cites things that do not exist, or forgets usages |

**Trigger:** a user (or their agent) names a repo path and a source and target with versions. Nothing else starts it. Vague input ("modernise this") is rejected with a question.

**Sizing and scope.** Once the repo facts are built, the engine sizes the migration from those facts and proposes a scope before any planning starts:

- **Size:** `none` (no code is affected, so the answer is a short version-bump plan), `small` (a few usages, all covered by official codemods, none high risk, so one combined planning pass), or `full` (the whole process). `none` is only given when the scan is complete, and it still lists the pack's behaviour changes, because those can hide without any matching code.
- **Questions,** asked only when the facts make them relevant: which apps or packages to plan for, whether to stop at an intermediate major, and whether to include changes that are only deprecated (still working on the target). The host agent asks the user, and the answers are recorded with the run.
- **Scope only narrows.** Answers pick from the offered options. They can never widen the paths, the level or the commands. Anything excluded is listed with the reason, and an excluded change that breaks on the target is shown to the human first. With no answers (CI, or a non-interactive run), the defaults apply: full scope, at the computed size.

**Output:** MIGRATION_PLAN.md plus plan.json made of structured findings (section 5). At L1, also per-stage patches and a verify report.

**Design rule:** the mechanical rows go to deterministic code and wrapped codemods, retrieval rows go to Context7 plus a curated rule pack, and only the judgment rows use the model. The human sees the plan and the exceptions.

## 3. Core principle: selectivity

The problem is not producing output, it is deciding which findings are worth a human's attention.

- The engine must be **exhaustive on facts** (every usage found, nothing silently dropped) and **selective on judgment** (only surface risks with evidence).
- Consequence of error is asymmetric. A wrong "low risk" label that hides a breaking change costs a broken migration. A wrong "high risk" label costs a few minutes. So the system leans toward flagging, but every flag must carry evidence, or it is dropped as noise.
- **Autonomy ladder:**
  - **L0, report only (default, no flag).** The plan, checklists and run report, written outside the repo.
  - **L1, sandboxed apply and verify (`--level 1`).** Each stage is applied in a sandbox copy, checked, kept or rolled back, and handed back as a patch. The user applies patches themselves.
  - **L2, write to the user's repo (a branch per stage).** Not built in v0.1.

  Moving up a rung always needs an explicit process flag (section 7A).

## 4. Scope

**The engine is general; packs are specific.** The engine (run state, plan schema, gates, verify loop, eval, permissions) knows nothing about any one framework. Each migration is a pack: rules, codemod references, verification recipe and golden cases.

Migrations come in four kinds, each checked differently:

| Kind | Example | How it is checked | v0.1 |
| --- | --- | --- | --- |
| A. Library or tool swap | Jest to Vitest, webpack to Vite | Existing tests, typecheck, build | Supported by the engine; no bundled pack |
| B. Version or framework upgrade | Next.js major, Django LTS to LTS | Tests, typecheck, framework checks, deprecation warnings | **The v0.1 packs** |
| C. Language translation | JS to Rust, Python to Go | Differential and characterization tests | Out of scope |
| D. Architecture | Monolith to services, multi-repo | Contract tests, shadow traffic, cutover plan | Out of scope (data model ready) |

**v0.1:** TS/JS and Python repos. Pack 1: Next.js major upgrade (including the React changes it requires). Pack 2: Django LTS to LTS upgrade. Single repo per run.

**Out of scope:** writing to the user's repo, other languages, kinds C and D, Next.js pages to app router (a later pack), a web UI, hosting, auth, "any technology" claims, third-party packs installed from outside the repo.

## 5. The finding: the unit of output

Every plan item is a finding with this shape (Zod schema in `schema/finding.ts`):

```
Finding {
  id, stage, repo_id,
  concern: api_change | behavior_change | dependency | config | test | build | docs,
  severity: info | low | medium | high | blocker,
  evidence: [{ repo_id, file, line_start, line_end, snippet_hash }],   // must resolve
  doc_refs: [{ library, version, url, doc_id }],                       // must come from the docs tool
  reasoning: string,       // why this matters for this repo
  action: string,          // what to change
  step_kind: codemod | manual,
  codemod?: string,        // allowlist ID, when step_kind = codemod
  rollback: string,        // required when severity >= high
  verify: string,          // command or check, e.g. "npm test -- routes"
  confidence: 0.0-1.0,
  source: rule_pack | usage_scan | codemod | agent_judgment
}
```

`source` matters: a finding backed by the rule pack and a scanned usage is trusted more than one the agent invented. Findings with `source = agent_judgment` and no evidence are rejected.

## 6. Architecture

```
            ┌──────────────── adapters (thin) ────────────────┐
 Skills     │   CLI           │   MCP server (stdio)  │  CI     │
 (generated │                 │                       │         │
  per pack) └──────────────────────────────────────────────────┘
                                   │
                    Core engine library (deterministic)
     ingest · context build · aggregate · gates · verify loop · emit · eval
     event spine (SQLite) · permissions (security/) · campaign and repo IDs
                                   │
       Language adapters   TS/JS (TypeScript compiler API) · Python (tree-sitter WASM)
       Knowledge           per library, one file per release: rules with events, typed matches, one official source link
       Migration packs     pack.json (which libraries, how to plan) · codemod references · verification recipe · golden cases
       Wrapped tools       @next/codemod · django-upgrade · the user's own test, typecheck and lint commands
```

Pipeline, per run:

```
Ingest -> Context build -> Size and scope -> Specialist fan-out -> Aggregate -> Gates -> Emit -> (L1) Verify loop
                             | api agent
                             | dependency/build agent
                             | behavior/runtime agent
                             | test/verification agent
```

1. **Ingest.** Validates input: path exists, source and target versions resolved from lockfiles (npm, pnpm, yarn, uv, poetry, pip requirements), git state clean or noted. Produces a run ID under a campaign and repo ID. Everything downstream is idempotent per run ID.
2. **Context builder.** Deterministic. `scan_repo` and `find_usages` build the repo facts through the language adapter for each file: dependency graph, import graph, entrypoints, usage list with file:line. Stored in SQLite with a symbol index; no vector DB for v0.1.
   - **Then size and scope** (section 2). `propose_scope` computes the size and the questions from the facts, and `set_scope` records the answers. Scope is frozen once planning starts. A `none` size skips the specialist fan-out, and a `small` size runs one combined lens instead of four. The gates run on every plan, whatever its size.
3. **Specialist fan-out.** The `plan_migration` prompt instructs the host agent to work four lenses independently, each with its own evidence packet and narrow instruction: **API**, **Dependency/build**, **Behavior/runtime**, **Verification**. Each lens returns findings only in the schema above. Lenses do not see each other's output.
4. **Aggregator.** `merge_findings` dedupes overlapping findings, resolves conflicts (take the higher severity and note it), groups findings into ordered stages (codemod steps first within a stage), and flags any usage with no covering finding.
5. **Gates (deterministic critic).** `validate_plan` runs the hard checks in section 7. Failing findings go back to the agent with the exact failure. Cap at 3 rounds, then the plan is emitted with unresolved items marked, never silently passed.
6. **Emit.** MIGRATION_PLAN.md for people, plan.json for tools, run_report.md (coverage, cost, what was dropped and why) and per-stage checklists.
7. **Verify loop (L1 only).** In a sandbox copy: record a baseline check run, then for each stage run the stage's codemods, apply the agent's patch, run the declared checks, run the test-integrity gate, and keep or roll back the stage. A stage that fails 3 times goes to unresolved. Output is one patch per kept stage plus `verify_report.json`.

**Reliability layer.** If Context7 is down or rate limited, fall back to cached docs and the rule pack and mark affected findings "docs unverified". If a lens returns invalid output, retry once, then record a gap. If a check command times out, the stage fails with the reason recorded. Always degrade to slower and more manual, never to wrong. Respect a time and token budget per run, and report when the budget cut something.

## 7. Trust: gates, confidence and human checkpoints

### Hard gates (no LLM involved)

`validate_plan` runs gates 1 to 6 on the plan:

1. Every evidence location exists, and the snippet hash matches the current file.
2. Every usage found by `find_usages` is covered by a finding or explicitly marked out of scope with a reason.
3. Every `doc_refs` entry came from the docs tool in this run (no invented links).
4. Every finding with severity high or blocker has a rollback and a verify step.
5. Stage order is valid: no stage depends on a change that comes later (checked against the import graph).
6. Schema valid, no duplicate IDs.

The verify loop runs gate 7 on each L1 stage patch:

7. **Test integrity.** Compared with the sandbox before the stage, the patch must not reduce the number of test cases or assertions, add skip, only, todo or xfail markers, delete test files or snapshots, or lower coverage thresholds. A stage that needs one of these changes goes to "Review first" with the reason, never into a kept patch silently.

### Confidence routing

- Confidence below 0.6 goes in a "needs human decision" section, not the main plan.
- Any blocker or high severity finding with `agent_judgment` source is always shown to the human first.
- Any usage the user's scope excluded, whose rule breaks on the target, is always shown to the human first.
- Everything else is included in the plan.
- The 0.6 threshold is a starting value. Tune it from eval results, not by feel.

**Audit trail.** Each run writes an event log: input, versions, retrieved doc IDs, prompt version, findings before and after each gate, every command run in the sandbox with its exit code and duration, and per-step cost (token counts if the host reports them). Prompts are versioned files; a new version never overwrites the old one.

**Feedback loop.** `record_feedback` lets the user mark a finding wrong or missing. It is stored with the run and becomes a new eval case. No training involved.

## 7A. Permissions: read-only by default

A sentence in a skill or prompt is not a security control. Safety is enforced in engine code, so it holds even if the host agent is told to ignore it.

- **The user's repo is never written,** at any level in v0.1. The engine's writes go to a separate output directory (default `.migration-planner/` outside the source tree, or a path the user passes) and its SQLite store.
- **Path boundary.** Every tool resolves paths and rejects anything outside the repo root passed at ingest (no `..`, no symlink escape). Reads skip `.env`, key files and anything in a deny list.
- **No execution in L0.** The verify field is text for the human.
- **Execution in L1, inside a sandbox only:**
  - The sandbox is a `git clone --no-hardlinks` of the repo into `<out>/<run_id>/sandbox`. Cloning only reads the source repo. An optional `--sandbox container` mode runs checks in a container instead.
  - `src/security/exec.ts` is the only module that can spawn a process. Its working directory is always inside the sandbox.
  - **Commands come only from user-owned config:** CLI flags or the AGENTS.md snippet. Never from MCP tool arguments, packs, prompts or the agent.
  - **Codemods come only from a core allowlist,** each with a pinned version. A pack names a codemod by ID; it cannot supply a command string.
  - The child environment is scrubbed (an allowlist of variables, no tokens or keys by default). Every command has a timeout.
  - Dependency installs the checks need are declared by the user as part of their check commands, and may use the network. This is stated in the run report.
- **Autonomy flags.** L0 needs no flag. L1 needs `--level 1`. `--level 2` is refused as "not built in v0.1". A tool argument can never raise the level.
- **Network (the engine's own).** Only Context7 calls, and only when configured. No telemetry. No repo contents are sent to Context7, only library names, versions and API symbol names.
- **Tests.** A permissions test suite proves each rule: write outside the output directory fails, path escape fails, execution at L0 fails, a command from a tool argument is refused, an unlisted codemod is refused, the source repo hash is unchanged after L1. These tests are part of every milestone gate.

## 8. Failure matrix

Keep this living in `docs/failure-modes.md` and add rows as real repos surprise you.

| Component | Engineering failures | LLM failures | Design response |
| --- | --- | --- | --- |
| Ingest | Monorepo with several lockfiles, dirty git tree, wrong version detected | Agent guesses versions | Resolve from lockfile only, ask when ambiguous |
| Context builder | Dynamic imports, re-exports, generated code, huge repos, parse errors, Python dynamic attribute access | n/a (deterministic) | Report unparsed files explicitly, size limits, incremental cache, heuristic labels |
| Docs retrieval | Context7 rate limit, outage, wrong library ID, stale version | Agent cites a doc it never fetched | Cache, pin versions, gate 3, "docs unverified" marker |
| Specialists | Output not matching schema, timeouts | Hallucinated APIs, vague advice, confident wrong severity | Narrow prompts, schema, evidence required, confidence field |
| Aggregator | Duplicate or conflicting findings, lost findings | Merges findings that are actually different | Deterministic dedupe key, conflict log |
| Gates | A check that passes wrongly (false pass) | Agent rewrites findings only to satisfy the gate | Gates test against real files, round cap, unresolved items stay visible |
| Verify loop | Flaky or slow tests, checks failing before any change, installs needing network, codemod crashes | Agent weakens or deletes tests to pass; agent tries to pass a command through a tool argument | Baseline run first, timeouts, retry cap, gate 7, commands from user config only |
| Emit | Plan too long to read | Padded prose | Needs-human section on top, per-stage summary |
| Permissions | Path traversal, symlink escape, write into the repo, process escaping the sandbox dir | Prompt or skill text tells the agent to edit files or run commands | Enforced in code, single spawn point, permissions tests |
| Rule packs and skills | Outdated pack, malformed rule, drift between pack and skill, codemod version drift | Skill trigger too broad so it loads on unrelated tasks | One source file, version pins, narrow trigger, lint in CI |

**Quadrant use:** for each cell ask what you know you don't know (add a test), what you will recognise on sight (add a check), and what you have never considered (add a case to the eval when a real repo surprises you).

## 9. Context7, skills and rule packs

Verified earlier against https://github.com/upstash/context7:

- Tools: `resolve-library-id` and `query-docs`. Remote URL https://mcp.context7.com/mcp with a bearer API key (free key for higher limits); also a local package and SDK.
- Docs are community-contributed, so treat snippets as cited evidence, not truth. This is why the rule pack and the gates exist.

**Composition:** v0.1 is agent-side (the plan prompt tells the host agent to call Context7 for each distinct API symbol; `get_migration_docs` is a cache and formatter that records which docs were retrieved, so gate 3 can check citations). Stretch: the engine calls Context7 as an MCP client.

**Skills.** One SKILL.md per pack, generated from the same file as the rule pack so they cannot drift.

- **Narrow trigger.** The description says exactly when to use it: "Use when planning a Next.js major version upgrade in a TypeScript or JavaScript repo". Never "use when working with React".
- **Short body.** Target under about 100 lines: the steps, the tool order, the output contract. No API tables inline.
- **Progressive disclosure.** Deeper material lives in `references/` files that the skill points to and the agent reads only when a finding needs it.
- **No scripts.** Skills are instructions only.
- **Lint in CI.** A check fails the build if a skill has no trigger sentence, exceeds the length target, or has references that do not exist.

**Knowledge and packs: shape and trust model.**

The migration knowledge is in two layers, so it can grow by release without rewrites and be shared between packs:

- **Knowledge, per library and kept by release** (`knowledge/<ecosystem>/<library>/`). `library.json` says how the library numbers its versions (`semver` or `pep440`, and whether a release unit is a major or an X.Y feature release), its LTS releases if any, where its official release notes and docs live, and its official codemods. One file per release holds the changes first made in that release, plus later events (for example "removed in 16") for changes made earlier. Release files only gain entries for their own release.
- **Each rule** is a short fact, not a copy of the docs: what changed and when (deprecated, removed, behaviour or default changed, renamed, peer requirement), when the new form became available, a **typed match** saying what to look for (an import, a call, a setting, a config key, a template filter, a dependency, …), the fix, an optional codemod ID, and **one** official source link. Only rules marked `reviewed` are used.
- **Packs are thin** (`packs/<pack>/pack.json`). A pack has a `kind`: `upgrade` (same library, from one version range to another) or `swap` (one library to another). It names its libraries (a primary, plus companions such as React for Next.js), the range it has been checked for, its usage adapter, staging and skill trigger. It holds no rules.
- **Ranges are composed at run time.** For an installed version S and a target T, the engine takes every rule with an event in (S, T]. It then derives whether each **breaks** or is only **deprecated**, and whether its fix also works on S (`lands_on`). Sizing, scope questions and staging read these. Any S to T inside the pack's checked range works without a new pack. Version comparison and composition are core code, because packs can't run code.
- **Maintainer tools keep the knowledge honest.** A release drafter turns a release's official notes into draft rules. A pack update report, run on every pack change, lists official items with no rule, dead source links, unreviewed drafts and rules with no seeded case. Both are outside the engine.
- Each library lists its **official doc sources**, as URL prefixes (the docs site and the docs folder of the official repo). Each doc the run uses is labelled with who fetched it (the engine, or the agent registering it) and whether it comes from an official source. A doc the agent registers from anywhere else is unofficial, and findings citing only such docs are marked "docs unverified". In the agent-side mode the engine can check where a doc *claims* to come from, not its content; only the server-side mode, where the engine fetches the doc itself, proves the content.
- Knowledge and packs are data (JSON plus markdown). No executable scripts, no network calls, no shell snippets. A rule may **reference** a codemod by its allowlist ID (for example `next-codemod:next-async-request-api`); the engine's core registry maps the ID to a pinned tool and arguments. Adding a codemod to the registry is a core change, reviewed as code.
- Each pack and each library has a changelog, and each pack has a version. The plan records the pack version and a hash of the knowledge files it used, so a plan can be reproduced.
- Only reviewed packs ship in the repo. Any change goes through a pull request and reruns the golden eval set.
- README limit, stated plainly: a third-party pack installed by a user is outside the project's review. The engine prints the pack name and version at the start of every run. Third-party packs loaded from outside the repo are not supported in v0.1.

**Other companions** to list in the README after checking current docs: GitHub MCP, filesystem MCP, git MCP.

**SDK:** official TypeScript SDK v2 (`@modelcontextprotocol/server`, stdio transport); confirm install commands from the README at M1 since this moves fast (https://github.com/modelcontextprotocol/typescript-sdk).

## 10. Evaluation

Build the eval set early, because a system that was great on its test data can drift.

### Tiers

1. **Unit tests** for the scanner, language adapters, usage finders, each gate, the verify loop and the permissions rules. Fast, run on every change.
2. **Golden cases:** 5 to 8 real public Next.js upgrades and at least 2 Django upgrades where the true PR is the ground truth. Check out the parent commit, run the planner, compare with the real diff. Include at least one failed or messy migration.
3. **Seeded-defect cases:** take a repo and plant tricky usages (indirect re-exports, config-driven behaviour, async API misuse, removed settings) to test recall on known hard items.
4. **Baseline comparison:** the same host agent with no engine, given the same task. The result that matters is "with engine vs. without", measured on the same metrics.

### Metrics

Plan quality:

- Usage coverage (recall of true changed usages) and precision (listed files the real PR also touched).
- Evidence validity: share of citations that resolve. Target 100%, enforced by gates.
- Severity calibration: of findings rated high, how many needed non-trivial edits in the real PR.
- False-alarm rate for high and blocker findings.

Outcomes (L1):

- First-pass verify rate: stages whose checks pass on the first attempt.
- Retries per stage, and the share of stages that end unresolved (need a human).
- Test-integrity incidents caught by gate 7.

Always:

- Cost and time per run.
- Repo untouched: a hash of the target repo before and after every eval run must match.

**Regression rule:** any change to a prompt, rule pack, skill, codemod registry entry or gate reruns the golden set and writes `eval/results.md`. Publish the results with the misses.

## 11. Tool surface

Every tool is also a CLI command over the same engine function.

| Tool | CLI | Purpose |
| --- | --- | --- |
| `scan_repo` | `scan` | Repo facts, versions, entrypoints, test setup |
| `find_usages` | `usages` | Every usage the pack cares about, with file:line and context |
| `get_rule_pack` | `pack` | Curated mappings, codemod references and known breaking changes (reports pack version) |
| `get_migration_docs` | `docs` | Docs for both sides via Context7, with cache and retrieval log |
| `assess_risk` | `risk` | Computed risk signals per usage (not LLM) |
| `propose_scope`, `set_scope` | `scope` | Size the migration (`none`, `small`, `full`), propose scope questions from the facts, record the answers (narrowing only) |
| `get_lens_packet`, `submit_findings` | (MCP only) | Lens evidence in, schema-checked findings out |
| `merge_findings` | `merge` | Aggregate, dedupe, order into stages |
| `validate_plan` | `validate` | Run gates 1 to 6, return per-finding pass or fail |
| `emit_plan` | `emit` | Write the plan, checklists and run report |
| `verify_stage`, `submit_stage_patch` | `verify` | L1 only: apply and check a stage in the sandbox |
| `get_verify_report` | `report` | Per-stage check results, gate 7 results, patches |
| `record_feedback` | `feedback` | Mark a finding wrong or missing, saved as a new eval case |
| Prompts and resources | n/a | `plan_migration` (lens instructions and schema), plan template, finding schema |

All tools are read-only against the target repo (section 7A).

## 12. Build process: spec spine, milestones, independent verifier

Write the design, break it into milestones with a written definition of done, and have something other than the builder verify each one.

- **Spine files in the repo:** `docs/design.md` (this document plus build decisions), `docs/invariants.md` (rules that must always hold, for example "no finding without evidence" and "the target repo is never written"), `docs/failure-modes.md`, `plan.md` (milestones).
- Each milestone states: files it touches, a demo command, success criteria, and what it must not break.
- **Gates per milestone:** tests pass, type check, lint, the eval smoke set, and a review by a separate agent session that sees only the milestone definition and the diff, not the builder's reasoning.
- **Comprehension check:** after each milestone, ask the agent to quiz you on what it wrote, and answer before moving on.

### Milestones

| # | Deliverable | Done when |
| --- | --- | --- |
| M0 | Failure matrix and invariants written, golden cases chosen (Next.js and Django) | Files exist, cases listed with base commits |
| M1 | Engine skeleton with CLI and MCP adapters, scan_repo (JS/TS and Python), event log with campaign and repo IDs, path boundary, read-only rule | Works from the CLI, Claude Code and Cursor; permissions tests pass; run recorded |
| M2 | Language adapters (TS, Python), import graphs, find_usages for Next.js, usage index | Recall on the seeded-defect repo reported |
| M3 | Rule pack schema, Next.js pack, get_rule_pack, assess_risk, generated skill | Pack and SKILL.md generated from one source; skill lint passes |
| M4 | Context7 integration, retrieval log, cache | Works with Context7 down (fallback tested) |
| M5 | Finding schema, plan_migration prompt, lenses | Valid findings on one real repo |
| M6 | merge_findings, validate_plan gates 1 to 6, emit | Bad plans are rejected for each gate type |
| M7 | Eval runner, 5 Next.js golden cases, baseline run | eval/results.md published |
| M8 | Sandboxed verify loop (L1), codemod registry, gate 7 | Permissions tests for execution pass; weakened-test fixtures are all rejected |
| M9 | Confidence routing, record_feedback, run report | Needs-human section works; report traces to events |
| M10 | Django pack (no core changes), README, open-source files, demo, name decided | Pack added with no core changes; README states limits |
| M11 | Publish to npm, tag v0.1 | Install works from a clean machine |

**Cut order if behind:** server-side Context7, then container sandbox mode, then the depth of the Django pack (fewer rules, same golden cases). Never cut the gates (including gate 7), the permissions rules, the eval or the clone-based verify loop.

## 13. Repo layout

```
migration-planner-mcp/          (working name)
  docs/ design.md invariants.md failure-modes.md plans/
  plan.md
  src/ core/ (engine API used by every adapter)
       cli/ server.ts (MCP adapter)
       tools/ (MCP tool handlers, thin)
       lang/ ts/ python/ (language adapters)
       analysis/ (scanner, usage adapters per pack, risk)
       pipeline/ (ingest, packets, aggregate, gates, emit, routing, report)
       verify/ (sandbox, stage loop, test integrity, codemod registry)
       security/ (path boundary, deny list, level, safe write, exec, network)
       schema/ finding.ts plan.ts rulePack.ts
       store/ (sqlite event spine, campaigns, repos)
       docs/ context7.ts cache.ts
  knowledge/npm/next/ npm/react/ pypi/django/ (library.json, releases/*.json)
  packs/nextjs-upgrade/ (pack.json, SKILL.md, references/)
  packs/django-upgrade/
  scripts/ (maintainer tools: pack build and lint, release drafter, pack update report, golden-case finder and re-checker; never imported by src/)
  prompts/ plan_migration.v1.md
  eval/ cases/ seeded/ baseline/ runner.ts results.md
  examples/ AGENTS.snippet.md
  test/ (incl. permissions)
  README.md LICENSE CONTRIBUTING.md AI_POLICY.md
```

## 14. Demo, README, the AGENTS.md snippet and open source

- **Demo (60 to 90 seconds):** point Claude Code at a real Next.js repo on an older major, ask for a plan, show the critic rejecting a draft for an uncited claim, then the passing plan with file:line links and the "needs human decision" section. Then run one stage at L1 and show gate 7 rejecting a patch that skipped a failing test. Show the repo is untouched afterwards (git status clean).
- **README order:** pitch, demo GIF, one-snippet install (CLI, Claude Code, Cursor), example output, how it works (diagram), eval table with baseline comparison, limits, how to add a pack.
- **Limits section:** TS/JS and Python only, two packs, single repo, never writes to your repo, L1 runs your declared checks in a sandbox copy, no third-party packs.
- **Optional AGENTS.md snippet.** `examples/AGENTS.snippet.md` is a few lines users paste into their repo's AGENTS.md: the check commands (test, typecheck, lint, and any install step), directories the engine should not read, and the target versions. The engine reads it at ingest if present. It is optional. A snippet can only add restrictions to the deny list, never widen the path boundary. Its check commands are the only commands L1 will run apart from allowlisted codemods.
- **Open source.** Apache-2.0. `CONTRIBUTING.md` makes packs the unit of contribution: a pack PR must include golden cases and pass the eval against the baseline. `AI_POLICY.md` asks contributors to disclose AI assistance and keeps the human contributor responsible for every change. A Claude Code plugin bundle packages the generated skills and the MCP config.

## 15. Risks

- **Scope creep to "any technology":** the pack kinds and v0.1 scope are the boundary.
- **MCP spec and SDK move fast:** pin versions, recheck docs at each milestone.
- **Context7 limits and doc quality:** cache, API key, cite, mark unverified.
- **Good eval migrations take time to find:** start the search at M0, for both packs.
- **Sandbox misuse or escape:** single spawn point, commands from user config only, cwd pinned to the sandbox, scrubbed environment, permissions tests. The clone sandbox is not a security boundary against hostile code; the user's own checks are code they already run. Say this in the README, and offer `--sandbox container` for stronger isolation.
- **Installs and checks need network or services** (databases for Django tests): declared by the user, reported in the run report, never assumed.
- **Python parsing fidelity:** tree-sitter gives syntax, not types. Usages found by name resolution are labelled heuristic, and recall is measured on a seeded Django repo.
- **Pack 2 forces changes to the engine:** that is the point of M10. Fix the coupling in a separate core PR before the pack PR.
- **Over-building:** v0.1 is two packs, one repo, L0 and L1. Add dashboards, embeddings and multi-repo behaviour only when the eval or users show a need.
- **Pack or skill supply chain:** reviewed packs only, no scripts, codemods only through the core registry, versions recorded in every plan.

## Appendix: sources and what was borrowed

- "Designing & Building PR Review Multi Agent System (3 Hours Build)", https://youtu.be/RiN02OXjeeQ (auto-captions). **Borrowed:** map the human process first; selectivity; structured findings; fan-out and fan-in; failure matrix; confidence escalation; event spine; early evals; milestones with independent verifier. **Not borrowed:** Postgres/pgvector, LangGraph, hosted dashboard (they conflict with local-first and zero cost).
- "Do We Still Need Complex Agent Setups?", https://youtu.be/iSpWw6Ak6Hk (auto-captions). **Borrowed:** short skills with narrow triggers and progressive disclosure; safety enforced in code, not prose; reviewed packs; the AGENTS.md snippet.
- "Migrating Code At Scale With LLMs At Google", https://arxiv.org/pdf/2504.09691. **Borrowed:** combine AST tooling, heuristics and the LLM; roll out in reviewable batches.
- Airbnb, "Accelerating Large-Scale Test Migration with LLMs" (coverage: https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/). **Borrowed:** staged validation per file with failures fed back and a retry cap; never delete tests to pass, which became gate 7.
