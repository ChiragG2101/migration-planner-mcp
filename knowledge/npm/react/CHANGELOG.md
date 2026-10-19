# npm/react knowledge changelog

Old release files change only to correct a mistake, recorded here.

## 2026-10-19

- `library.json`: covers `react` and `react-dom`, complete from 18; notes from react.dev's React 18 and React 19 upgrade guides; the official React 19 codemods.
- `releases/18.json` and `19.json`: draft rules from those guides. A section nested under another configured section (the React 19 removals) is its own list of items.

## 2026-10-20

- Review against each rule's `source` section, in a session that did not write the rules. 12 rules in 19 are now `reviewed`: `useref-requires-an-argument`, `the-jsx-namespace-in-typescript`, `removed-proptypes-and-defaultprops-for-functions`, `removed-legacy-context-using-contexttypes-and-getchildcontex`, `removed-string-refs`, `removed-react-createfactory`, `removed-react-test-renderer-shallow`, `removed-react-dom-test-utils`, `removed-reactdom-render`, `removed-reactdom-hydrate`, `removed-unmountcomponentatnode` and `removed-reactdom-finddomnode`.
- Corrections made in review:
  - `react/removed-proptypes-and-defaultprops-for-functions`: no codemod. The section's `prop-types-typescript` codemod covers `propTypes`, and the match binds `defaultProps`.
  - `react/removed-react-createfactory`: `no_equivalent` is false; the section's replacement is JSX.
  - `react/removed-react-test-renderer-shallow`: the match is `react-test-renderer/shallow`, not all of `react-test-renderer` (deprecated, not removed), and `no_equivalent` is false, with the mapping to `react-shallow-renderer` that the section gives.
  - `react/stricter-hydration-errors-…` (18, draft): the title is the item's bold lead only. The full sentence ("deleting a node on the client") looked like a shell command to the pack lint.
- Matched drafts left as drafts, each with the reason in its `notes`: `react-dom-reactdom-render-has-been-deprecated-using-it-will-` (18; same match as `removed-reactdom-render`, and never inside a run because Next.js 14 and later need React 18) and `removed-deprecated-typescript-types` (19; the section names no type, and `MutableRefObject` is documented as deprecated in the `useRef` section).
