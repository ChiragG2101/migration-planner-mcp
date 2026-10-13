# Migration Planner MCP - PRD and Build Spec (v3)

Status: v3 of the Oct 13 spec. Same product as v2, plus four additions from the "agent setups" video: short narrow skills, read-only enforced in code, reviewed rule packs, and an optional AGENTS.md snippet. Everything else is unchanged. You build it; this is the plan.

**One line:** a local-first MCP server that reads a codebase plus a migration target (for example Express to Hono) and returns a staged plan where every step cites code and docs, has a risk rating, a rollback note and a verification check. The plan is checked by a program, not by another LLM opinion.

## 0. What changed

### v3 (new in this version)

| Area | v2 | v3 |
| --- | --- | --- |
| Skills | One SKILL.md per migration | Short, narrow trigger, deeper reference files loaded only when needed (section 9) |
| Permissions | Plan-quality gates only | Read-only by default, enforced in code; anything beyond report-only needs an explicit flag (section 7A) |
| Rule packs | Curated | Reviewed, versioned, no scripts in v1; trust limits stated (section 9) |
| Repo input | Scanned from code | Optional AGENTS.md snippet users paste into their repo (section 14) |

### v2 (carried over)

| Area | v1 | v2 |
| --- | --- | --- |
| Starting point | Tools first | Human migration workflow first (section 2) |
| Core principle | Validator exists | Selectivity: what the system decides vs. what the human must decide (section 3) |
| Failure thinking | A short risk list | Per-component failure matrix, engineering side and LLM side (section 8) |
| Plan format | Stages with risk | Structured findings with concern, severity, evidence, reasoning, confidence (section 5) |
| Agents | One host agent plus critic | Specialist fan-out and an aggregator, with deterministic gates (section 6) |
| Trust | Not covered | Confidence routing, human approval points, audit trail (section 7) |
| Eval | 3 to 5 repos | Tiered eval with a baseline to beat, regression runs, cost tracking (section 10) |
| Build process | 2-week day list | Milestones with a written definition of done and an independent verifier (section 12) |

## 1. Constraints (unchanged, from your brief)

- **Local-first, zero hosting cost.** Runs on the user's machine over stdio. No servers, no paid database. Storage is SQLite and plain files.
- **Your own model does the writing.** MCP "sampling" is deprecated in the current MCP spec (https://modelcontextprotocol.io/specification/2026-07-28/client/sampling), so the server does deterministic work and the host agent (Claude Code, Cursor) is the LLM. An optional CLI mode can use the user's own API key.
- **Context7 pairing** for old and new docs (section 9).
- **Honest claims.** Say "currently building" until it ships with real eval numbers.

## 2. Map the mess: how a senior engineer plans a migration today

Remove the AI and write down every micro-decision a human makes, then mark which are mechanical, which are judgment, and where the human fails. For Express to Hono:

| Step a human takes | Type | Where humans fail |
| --- | --- | --- |
| Read package.json, find entrypoints, versions, test setup | Mechanical | Misses monorepo packages, secondary entrypoints |
| Grep for every use of the old API (routes, middleware, req/res, error handlers) | Mechanical | Misses indirect usage: wrapped helpers, re-exports, third-party middleware |
| Read the migration docs for both versions | Retrieval | Reads stale docs, skips the breaking-changes page |
| Spot things with no equivalent (custom middleware, streaming, global state) | Judgment | Finds them late, during the migration |
| Order the work so the build stays green | Judgment | Big-bang plan, no rollback point |
| Decide what to test after each step | Judgment | Tests too late or not at all |
| Write the plan and get it reviewed | Writing | Plan cites things that do not exist, or forgets usages |

**Trigger:** a user (or their agent) names a repo path and a source and target library with versions. Nothing else starts it. Vague input ("modernise this") is rejected with a question.

**Output:** MIGRATION_PLAN.md plus plan.json made of structured findings (section 5).

**Design rule:** the mechanical rows go to deterministic code, retrieval rows go to Context7 plus a curated rule pack, and only the judgment rows use the model. The human sees the plan and the exceptions.

## 3. Core principle: selectivity

The problem is not producing output, it is deciding which findings are worth a human's attention.

- The server must be **exhaustive on facts** (every usage found, nothing silently dropped) and **selective on judgment** (only surface risks with evidence).
- Consequence of error is asymmetric. A wrong "low risk" label that hides a breaking change costs a broken migration. A wrong "high risk" label costs a few minutes. So the system leans toward flagging, but every flag must carry evidence, or it is dropped as noise.
- **Autonomy ladder:** L0 report only (MVP). L1 also generate per-stage checklists and test stubs. L2 open a branch per stage. Executing the migration is out of scope until L0 metrics are good. Moving up a rung always needs an explicit flag (section 7A).

## 4. Scope

**MVP:** TypeScript/JavaScript repos only. Express to Hono as the flagship. Second rule pack: Jest to Vitest. Plan only. No code is changed.

**Out of scope:** running the migration, other languages, a web UI, hosting, auth, "any technology" claims.

## 5. The finding: the unit of output

Every plan item is a finding with this shape (Zod schema in `schema/finding.ts`):

```
Finding {
  id, stage,
  concern: api_change | behavior_change | dependency | config | test | build | docs,
  severity: info | low | medium | high | blocker,
  evidence: [{ file, line_start, line_end, snippet_hash }],   // must resolve
  doc_refs: [{ library, version, url }],                       // must come from the docs tool
  reasoning: string,       // why this matters for this repo
  action: string,          // what to change
  rollback: string,        // required when severity >= high
  verify: string,          // command or check, e.g. "npm test -- routes"
  confidence: 0.0-1.0,
  source: rule_pack | usage_scan | agent_judgment
}
```

`source` matters: a finding backed by the rule pack and a scanned usage is trusted more than one the agent invented. Findings with `source = agent_judgment` and no evidence are rejected.

## 6. Architecture

```
Host agent (user's model) <--MCP stdio--> migration-planner server

Ingest -> Context build -> Specialist fan-out -> Aggregate -> Gates -> Emit
                             | api agent
                             | dependency/build agent
                             | behavior/runtime agent
                             | test/verification agent

Event spine (SQLite) records every step; reliability layer degrades gracefully
```

1. **Ingest.** Validates input: path exists, source and target versions resolved from the lockfile, git state clean or noted. Produces a run ID. Everything downstream is idempotent per run ID.
2. **Context builder.** Deterministic. `scan_repo` and `find_usages` build the repo facts using the TypeScript compiler API or tree-sitter: dependency graph, import and re-export graph, entrypoints, usage list with file:line. Stored in SQLite with a symbol index; no vector DB for MVP, add embeddings only if usage search measurably misses things.
3. **Specialist fan-out.** The `plan_migration` prompt instructs the host agent to work four lenses independently, each with its own evidence packet and narrow instruction: **API** (route, middleware, handler, error-handling mappings); **Dependency/build** (package changes, peer deps, bundler and TypeScript config, runtime targets); **Behavior/runtime** (body parsing, async error handling, streaming, req/res mutation, global state); **Verification** (what to test after each stage, coverage gaps). Each lens returns findings only in the schema above. Lenses do not see each other's output.
4. **Aggregator.** `merge_findings` dedupes overlapping findings (same file, line and action), resolves conflicts (take the higher severity and note it), groups findings into ordered stages, and flags any usage with no covering finding.
5. **Gates (deterministic critic).** `validate_plan` runs the hard checks in section 7. Failing findings go back to the agent with the exact failure. Cap at 3 rounds, then the plan is emitted with unresolved items marked, never silently passed.
6. **Emit.** MIGRATION_PLAN.md for people, plan.json for tools, and run_report.md (coverage, cost, what was dropped and why).

**Reliability layer.** If Context7 is down or rate limited, fall back to cached docs and the rule pack and mark affected findings "docs unverified". If a lens returns invalid output, retry once, then record a gap. Always degrade to slower and more manual, never to wrong. Respect a time and token budget per run, and report when the budget cut something.

## 7. Trust: gates, confidence and human checkpoints

### Hard gates in validate_plan (no LLM involved)

1. Every evidence location exists, and the snippet hash matches the current file.
2. Every usage found by `find_usages` is covered by a finding or explicitly marked out of scope with a reason.
3. Every `doc_refs` URL came from the docs tool in this run (no invented links).
4. Every finding with severity high or blocker has a rollback and a verify step.
5. Stage order is valid: no stage depends on a change that comes later (checked against the import graph).
6. Schema valid, no duplicate IDs.

### Confidence routing

- Confidence below 0.6 goes in a "needs human decision" section, not the main plan.
- Any blocker or high severity finding with `agent_judgment` source is always shown to the human first.
- Everything else is included in the plan.
- The 0.6 threshold is a starting value. Tune it from eval results, not by feel.

**Audit trail.** Each run writes an event log: input, versions, retrieved doc IDs, prompt version, findings before and after each gate, and per-step cost (token counts if the host reports them). Prompts are versioned files; a new version never overwrites the old one.

**Feedback loop.** `record_feedback` lets the user mark a finding wrong or missing. It is stored with the run and becomes a new eval case. No training involved.

## 7A. Permissions: read-only by default (new in v3)

A sentence in a skill or prompt is not a security control. Safety is enforced in server code, so it holds even if the host agent is told to ignore it.

- **Read-only by default.** The server never writes inside the target repo. Its only writes go to a separate output directory (default `.migration-planner/` outside the source tree, or a path the user passes) and its SQLite store.
- **Path boundary.** Every tool resolves paths and rejects anything outside the repo root passed at ingest (no `..`, no symlink escape). Reads skip `.env`, key files and anything in a deny list.
- **No execution.** The server does not run the target repo's scripts, tests or install commands in L0. The verify field is text for the human; it is never run by the server.
- **Autonomy flags.** L0 is the default and needs no flag. L1 (checklists and test stubs written to the output directory) needs `--level 1`. L2 (a branch per stage) needs `--level 2` plus an explicit approval step per stage, and is not built in v0.1.
- **Network.** Only Context7 calls, and only when configured. No telemetry. No repo contents are sent to Context7, only library names, versions and API symbol names.
- **Tests.** A permissions test suite proves each rule: write outside the output directory fails, path escape fails, L1 output without the flag fails. These tests are part of the milestone gates.

## 8. Failure matrix

Keep this living in `docs/failure-modes.md` and add rows as real repos surprise you.

| Component | Engineering failures | LLM failures | Design response |
| --- | --- | --- | --- |
| Ingest | Monorepo with several lockfiles, dirty git tree, wrong version detected | Agent guesses versions | Resolve from lockfile only, ask when ambiguous |
| Context builder | Dynamic imports, re-exports, generated code, huge repos, parse errors | n/a (deterministic) | Report unparsed files explicitly, size limits, incremental cache |
| Docs retrieval | Context7 rate limit, outage, wrong library ID, stale version | Agent cites a doc it never fetched | Cache, pin versions, gate 3, "docs unverified" marker |
| Specialists | Output not matching schema, timeouts | Hallucinated APIs, vague advice, confident wrong severity | Narrow prompts, schema, evidence required, confidence field |
| Aggregator | Duplicate or conflicting findings, lost findings | Merges findings that are actually different | Deterministic dedupe key, conflict log |
| Gates | A check that passes wrongly (false pass) | Agent rewrites findings only to satisfy the gate | Gates test against real files, round cap, unresolved items stay visible |
| Emit | Plan too long to read | Padded prose | Needs-human section on top, per-stage summary |
| Permissions (new) | Path traversal, symlink escape, write into the repo | Prompt or skill text tells the agent to edit files or run commands | Enforced in code, permissions tests, no execution in L0 |
| Rule packs and skills (new) | Outdated pack, malformed rule, drift between pack and skill | Skill trigger too broad so it loads on unrelated tasks | One source file, version pin, narrow trigger, lint in CI |

**Quadrant use:** for each cell ask what you know you don't know (add a test), what you will recognise on sight (add a check), and what you have never considered (add a case to the eval when a real repo surprises you).

## 9. Context7, skills and rule packs

Verified earlier against https://github.com/upstash/context7:

- Tools: `resolve-library-id` and `query-docs`. Remote URL https://mcp.context7.com/mcp with a bearer API key (free key for higher limits); also a local package and SDK.
- Docs are community-contributed, so treat snippets as cited evidence, not truth. This is why the rule pack and the gates exist.

**Composition:** MVP is agent-side (the plan prompt tells the host agent to call Context7 for each distinct API symbol; `get_migration_docs` is a cache and formatter that records which docs were retrieved, so gate 3 can check citations). Stretch: the server calls Context7 as an MCP client.

**Skills (updated in v3).** One SKILL.md per migration, generated from the same file as the rule pack so they cannot drift. Design rules:

- **Narrow trigger.** The description says exactly when to use it: "Use when planning an Express to Hono migration in a TypeScript repo". Never "use when working with backends".
- **Short body.** Target under about 100 lines: the steps, the tool order, the output contract. No API tables inline.
- **Progressive disclosure.** Deeper material lives in `references/` files (breaking changes, middleware mappings, streaming notes) that the skill points to and the agent reads only when a finding needs it.
- **No scripts in v1.** Skills are instructions only.
- **Lint in CI.** A check fails the build if a skill has no trigger sentence, exceeds the length target, or has references that do not exist.

**Rule packs: trust model (new in v3).** Rule packs and skills shape what the agent does, so treat them like code you ship.

- Packs are data (JSON plus markdown). No executable scripts, no network calls, no shell snippets in v1.
- Each pack has a version and a changelog. The plan records the pack version used, so a plan can be reproduced.
- Only reviewed packs ship in the repo. Any change goes through a pull request and reruns the golden eval set.
- README limit, stated plainly: a third-party pack installed by a user is outside the project's review. The server prints the pack name and version at the start of every run. Third-party packs are not supported in v0.1.

**Other companions** to list in the README after checking current docs: GitHub MCP, filesystem MCP, git MCP.

**SDK:** official TypeScript SDK v2 (`@modelcontextprotocol/server`, stdio transport); confirm install commands from the README on day 1 since this moves fast (https://github.com/modelcontextprotocol/typescript-sdk).

## 10. Evaluation

Build the eval set early, because a system that was great on its test data can drift.

### Tiers

1. **Unit tests** for scanner, usage finder, each gate, and the permissions rules. Fast, run on every change.
2. **Golden cases:** 5 to 8 real public migrations where the true PR is the ground truth. Check out the parent commit, run the planner, compare with the real diff. Include at least one failed or messy migration.
3. **Seeded-defect cases:** take a repo and plant tricky usages (custom middleware, streaming, indirect re-export) to test recall on known hard items.
4. **Baseline comparison:** the same host agent with no MCP server, given the same task. The result that matters is "with server vs. without", measured on the same metrics.

### Metrics

- Usage coverage (recall of true changed usages) and precision (listed files the real PR also touched).
- Evidence validity: share of citations that resolve. Target 100%, enforced by gates.
- Severity calibration: of findings rated high, how many needed non-trivial edits in the real PR.
- False-alarm rate for high and blocker findings.
- Ordering check (stretch): apply stages mechanically on a branch and see whether the build and tests still pass at each stage.
- Cost and time per run.
- Repo untouched: a hash of the target repo before and after every eval run must match.

**Regression rule:** any change to a prompt, rule pack, skill or gate reruns the golden set and writes `eval/results.md`. Publish the results with the misses.

## 11. Tool surface

| Tool | Purpose |
| --- | --- |
| `scan_repo` | Repo facts, versions, entrypoints, test setup |
| `find_usages` | Every usage of the source library, with file:line and context |
| `get_rule_pack` | Curated API mappings and known breaking changes (reports pack version) |
| `get_migration_docs` | Docs for both sides via Context7, with cache and retrieval log |
| `assess_risk` | Computed risk signals per usage (not LLM) |
| `merge_findings` | Aggregate, dedupe, order into stages |
| `validate_plan` | Run all hard gates, return per-finding pass or fail |
| `record_feedback` | Mark a finding wrong or missing, saved as a new eval case |
| Prompts and resources | `plan_migration` (lens instructions and schema), plan template, finding schema |

All tools are read-only against the target repo (section 7A).

## 12. Build process: spec spine, milestones, independent verifier

Write the design, break it into milestones with a written definition of done, and have something other than the builder verify each one.

- **Spine files in the repo:** `docs/design.md` (this document), `docs/invariants.md` (rules that must always hold, for example "no finding without evidence" and "the target repo is never written"), `docs/failure-modes.md`, `plan.md` (milestones).
- Each milestone states: files it touches, a demo command, success criteria, and what it must not break.
- **Gates per milestone:** tests pass, type check, lint, the eval smoke set, and a review by a separate agent session that sees only the milestone definition and the diff, not the builder's reasoning.
- **Comprehension check:** after each milestone, ask the agent to quiz you on what it wrote, and answer before moving on.

### Milestones (about 3 weeks)

| # | Deliverable | Done when |
| --- | --- | --- |
| M0 | Failure matrix and invariants written, 3 golden cases chosen | Files exist, cases listed with base commits |
| M1 | MCP skeleton, scan_repo, event log, path boundary and read-only rule | Works from Claude Code or Cursor; permissions tests pass; run recorded |
| M2 | find_usages for Express, usage index | Recall on seeded-defect repo reported |
| M3 | Rule pack, get_rule_pack, assess_risk, short skill with references | Pack and SKILL.md generated from one source; skill lint passes |
| M4 | Context7 integration, retrieval log, cache | Works with Context7 down (fallback tested) |
| M5 | Finding schema, plan_migration prompt, lenses | Valid findings on one real repo |
| M6 | merge_findings, validate_plan gates | Bad plans are rejected for each gate type |
| M7 | Eval runner, 5 golden cases, baseline run | eval/results.md published |
| M8 | Confidence routing, record_feedback, run report, output flags (L1 behind --level 1) | Needs-human section works; L1 refused without the flag |
| M9 | Second migration (Jest to Vitest), README, AGENTS.md snippet, demo | Rule pack added with no core changes |
| M10 | Publish to npm, tag v0.1, post | Install works from a clean machine |

**Cut order if behind:** L1 output, second migration, server-side Context7, CLI mode. Never cut the gates, the permissions rules or the eval.

## 13. Repo layout

```
migration-planner-mcp/
  docs/ design.md invariants.md failure-modes.md
  plan.md
  src/ server.ts tools/ analysis/ pipeline/ (ingest, aggregate, gates)
       security/ (path boundary, deny list, level flags)
       schema/ finding.ts plan.ts
       store/ (sqlite event spine)
       docs/context7.ts
  rules/express-to-hono/ (rules.json, SKILL.md, references/)
  rules/jest-to-vitest/
  prompts/ plan_migration.v1.md
  eval/ cases/ seeded/ baseline/ runner.ts results.md
  examples/ AGENTS.snippet.md
  test/ (incl. permissions)
  README.md
```

## 14. Demo, README and the AGENTS.md snippet

- **Demo (60 to 90 seconds):** point Claude Code at a real Express repo, ask for a plan, show the critic rejecting a draft for an uncited claim, then the passing plan with file:line links and the "needs human decision" section. Show the repo is untouched afterwards (git status clean).
- **README order:** pitch, demo GIF, one-snippet install, example output, how it works (diagram), eval table with baseline comparison, limits, how to add a rule pack.
- **Limits section:** TS/JS only, two migrations, plan only, read-only, no third-party packs.
- **Optional AGENTS.md snippet (new in v3).** `examples/AGENTS.snippet.md` is a few lines users paste into their repo's AGENTS.md: the test command, directories the planner should not touch or read, and the target versions. The server reads it at ingest if present and uses it to fill the verify field and the deny list. It is optional, and the server works without it. A snippet can only add restrictions to the deny list, never widen the path boundary.

## 15. How it reads on your resume and in outreach

Only claim what exists when you send it.

- **After it ships:** "Built migration-planner-mcp, an open-source MCP server that turns a repo and a migration target into a staged, evidence-cited plan, with a deterministic plan validator, code-enforced read-only access and an eval harness scored against N real public migrations." Fill N and any metric from real results only.
- **Until then:** "currently building".
- **What it shows:** MCP design, multi-agent fan-out with deterministic gates, evals against a baseline, and honest cost and failure reporting. It connects to your Tortoise pipeline work. Do not claim adoption, stars or accuracy before they exist.

## 16. Risks

- **Scope creep to "any technology":** the rule packs are the boundary.
- **MCP spec and SDK move fast:** pin versions, recheck docs at each milestone.
- **Context7 limits and doc quality:** cache, API key, cite, mark unverified.
- **Good eval migrations take time to find:** start the search at M0.
- **Over-building:** MVP is L0 with SQLite and four lenses; add dashboards and embeddings only when the eval shows a need.
- **Pack or skill supply chain:** reviewed packs only, no scripts, version recorded in every plan.

## Appendix: sources and what was borrowed

- "Designing & Building PR Review Multi Agent System (3 Hours Build)", https://youtu.be/RiN02OXjeeQ (auto-captions). **Borrowed:** map the human process first; selectivity; structured findings; fan-out and fan-in; failure matrix; confidence escalation; event spine; early evals; milestones with independent verifier. **Not borrowed:** Postgres/pgvector, LangGraph, hosted dashboard (they conflict with local-first and zero cost).
- "Do We Still Need Complex Agent Setups?", https://youtu.be/iSpWw6Ak6Hk (auto-captions). A concept talk on layers (AGENTS.md, skills, MCP, deterministic permissions). **Borrowed:** short skills with narrow triggers and progressive disclosure; safety enforced in code, not prose; reviewed packs; the AGENTS.md snippet. **Not borrowed:** the Databricks and hosted-app segment, and the deploy and Kubernetes example (out of scope for a local planner).
