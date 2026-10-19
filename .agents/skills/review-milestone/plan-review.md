# Reviewing a plan-only diff

Use this when the diff changes only `docs/`, `plan.md`, `AGENTS.md` or `.agents/`, with no code. Steps 1 to 5 of `SKILL.md` mostly can't run on such a diff, and a free read of a large spec finds a different sample of problems each time. This procedure works like the engine itself: a deterministic check first, a fixed list of what to check, narrow lenses, findings verified before they are reported, and a round cap with open items that are never marked passed.

Inputs: the diff, and every file under `docs/`, `AGENTS.md` and `.agents/skills/` that it touches or that states a rule it touches. Plan consistency can't be judged from one milestone file.

## 1. Run the deterministic check

Run `scripts/check-spine.sh`. Each failure is a finding at its file and line. Don't recheck invariant IDs, decision IDs or planned test names by hand; spend the reading on what the script can't check.

## 2. List the rules the diff adds or changes

For each changed hunk, ask what must now always or never happen. Each answer is a rule; a wording-only edit is not. Write one row per rule:

| Rule (one line) | Home (D-n or INV-n) | Every place it is stated | Planned test or check | Milestones whose work it constrains |
| --- | --- | --- | --- | --- |

Find "every place" with `grep` on the rule's key terms across `docs/`, `AGENTS.md` and `.agents/skills/`, not by memory. Find "milestones it constrains" by asking which milestone builds, records, adds, deletes or reads the thing the rule is about.

## 3. Check every row against the same five questions

1. **Home:** is the rule stated in full in one D-record or invariant, with the other places agreeing with it or pointing to it?
2. **Consistent:** does every place say the same thing: the same numbers, conditions, exceptions and owner?
3. **Enforced:** does a planned test or check fail when the rule breaks, and does the owning milestone's Tests section list it?
4. **Impact:** for each milestone in the last column, can its tasks still be done as written? Walk what that milestone builds or changes against the rule. This is where a new rule collides with work in another milestone.
5. **Constraints:** does the rule weaken C1 to C10, a gate, a test or a threshold, or open a way to pass a gate without meeting its intent?

Every row gets all five answers in the report, even when the answer is "yes".

## 4. Lenses

By default one reviewer runs the four lenses one after another, in the order below. Running them as four parallel reviewers costs about four times as much and has not been shown to find more, so do it only when the user asks for it.

- **consistency:** questions 1 and 2;
- **enforcement:** question 3, plus the failure-mode rows and invariants the diff adds;
- **buildability:** question 4, walking M1 to M10 in order;
- **adversarial:** question 5, trying to pass each gate the diff touches without meeting its intent.

## 5. Verify each finding before reporting it

Open the cited file and line, and confirm the text says what the finding claims. Drop any finding that doesn't hold. A finding without a file and line is not reported.

## 6. Report

Two separate verdicts:

- **Milestone verdict**, only when the diff belongs to a milestone: does it meet that milestone's definition of done (for M0, the overview's M0 section)? A plan defect outside that definition doesn't block the milestone. It is still reported below.
- **Plan findings**, each with its file and line, its rule row, the milestone that owns it and a concrete fix, classed as:
  - **blocking:** two documents contradict each other; a constraint, gate, test or threshold is weakened; a rule has no planned enforcement; or a milestone can't be built as written without inventing a rule;
  - **open item:** a real question the owning milestone's builder must settle with the user, where the plan as written is not contradictory;
  - **non-blocking:** wording or clarity.

Never approve a plan change with a blocking finding open.

## 7. Later rounds and the cap

- Before each review, record the reviewed state with `git stash create`, which prints a commit ID without changing the tree, or use the commit if there is one.
- A later round reviews the fix (`git diff <recorded state>`), plus the rule rows it touches and the files those rows name. It is given the earlier rounds' findings, which are not the builder's reasoning, and confirms each one is closed.
- A plan change gets at most **3** review rounds. After round 3, every finding still open is written into the owning milestone's plan under `## Open items`, with its rule and the round that found it. It is never marked resolved. `implement-milestone` resolves a milestone's open items with the user before any code is written.
