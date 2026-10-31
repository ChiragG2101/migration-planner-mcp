# Migration plan

- Pack: `nextjs-upgrade@1.0.0`
- Prompt: `v1`
- Status: **capped**

## Review first (2)

Read these before anything else. They are listed here whatever their confidence.

#### judged — HIGH (api_change) _docs unverified_
_high finding from agent judgment; stage 1. Prep on the old version_
- `app/judged.ts:2-2`

**Action.** Fix judged.
**Rollback.** Revert the edit.
**Verify.** Run the tests.

- **Stage 2. Bump next**: gate 7 held the patch for review: fewer_test_cases in app/a.test.ts: 3 -> 2. Patch: `patches/needs-review/stage-bump.patch`

## Unresolved (2)

These failed a gate after the round or attempt cap and were not resolved. Review them before applying the plan.

- **g1_evidence** (plain): the snippet at app/plain.ts:2 no longer matches
- **verify** (stage 2. Bump next): rejected on all 3 attempts; the sandbox was rolled back to the stage start

## Needs human decision (1)

Confidence below 0.6. Decide whether each applies before following the plan.

#### unsure — MEDIUM (api_change) _docs unverified_
_confidence 0.4_
- `app/unsure.ts:2-2`

**Action.** Fix unsure.
**Rollback.** Revert the edit.
**Verify.** Run the tests.

## Summary

1. **Prep on the old version**: 3 findings (0 codemod, 3 manual), highest high; 2 listed above.
   Verify: kept after 2 attempts.
2. **Bump next**: 2 findings (1 codemod, 1 manual), highest high.
   Verify: unresolved after 3 attempts.

## Stages

### 1. Prep on the old version

_2 more listed above._

#### plain — MEDIUM (api_change)
- `app/plain.ts:2-2`

**Action.** Fix plain.
**Rollback.** Revert the edit.
**Verify.** Run the tests.

### 2. Bump next
_depends on: stage-prep_

#### engine-bump — HIGH (dependency)
- `app/engine-bump.ts:2-2`

**Action.** Fix engine-bump.
**Rollback.** Revert the edit.
**Verify.** Run the tests.

#### codemod — MEDIUM (api_change)
- `app/codemod.ts:2-2`

**Action.** Fix codemod.
**Codemod.** `next-codemod:next-async-request-api`
**Rollback.** Revert the edit.
**Verify.** Run the tests.

---

Pack `nextjs-upgrade@1.0.0` version 1.0.0, prompt v1, gates g1_evidence, g2_coverage (engine 0.0.0), confidence threshold 0.6 (default).
The target repo was not modified by this plan (repo hash ffffffffffff before and after).
