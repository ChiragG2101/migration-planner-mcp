# nextjs-upgrade changelog

## 0.3.0 (unreleased)

- Rules reviewed on 2026-10-20 in a fresh session against each rule's official source section (`docs/design.md` D29): 26 `npm/next` rules (14: 1, 15: 12, 16: 13) and 12 `npm/react` rules (19) are now `reviewed`. The corrections and the matched drafts left as drafts, with the reasons, are in each library's `CHANGELOG.md`.
- `next-tricky` gains a seeded `expect: change` case for every reviewed rule, and an indirect case (through a helper or a re-export) for every import and call rule.

## 0.2.0 (unreleased)

- Draft rules for Next.js 14, 15 and 16 and React 18 and 19, taken from the official upgrade guides on 2026-10-19. They stay `draft` until a fresh session reviews them (`docs/design.md` D29).

## 0.1.0 (unreleased)

- First version. Supported range fixed on 2026-10-19 at Next.js 14 to 16, checked against the current releases (`next` 16.4.2, `react` 19.3.1) and nextjs.org's version-14, version-15 and version-16 upgrade guides (`docs/design.md` D29).
- Libraries: `npm/next` (primary), `npm/react` (companion).
