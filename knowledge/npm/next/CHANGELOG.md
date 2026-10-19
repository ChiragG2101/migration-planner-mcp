# npm/next knowledge changelog

Old release files change only to correct a mistake, recorded here.

## 2026-10-19

- `library.json`: covered from 14; notes from nextjs.org's upgrade guides; the official `@next/codemod` transforms for 13.2 to 16.
- `releases/14.json`, `15.json` and `16.json`: draft rules from those guides. 15 records a later `removed` event for the `@next/font` rule defined in 14, because the version 15 guide still lists that removal. 16 records the removal of synchronous access for the async request APIs defined in 15.

## 2026-10-20

- Review against each rule's `source` section, in a session that did not write the rules. 26 rules are now `reviewed`: in 14, `@next/font`; in 15, `react-19`, `runtime-configuration-breaking-change`, `route-handlers`, `bundlepagesrouterdependencies`, `serverexternalpackages`, `nextrequest-geolocation`, `async-request-ip`, `async-cookies`, `async-headers`, `async-draft-mode`, `async-params` and `async-search-params`; in 16, `middleware-to-proxy`, `parallel-routes-default-js-requirement`, `sass-node-modules-imports`, `revalidatetag`, `cachelife-and-cachetag`, `next-legacy-image-component-deprecated`, `images-domains-configuration-deprecated`, `amp-support`, `next-lint-command`, `runtime-configuration`, `devindicators-options`, `experimental-dynamicio-and-experimental-usecache` and `unstable-rootparams`.
- Corrections made in review:
  - `next/runtime-configuration-breaking-change`: `replacement_since` 14, because the section says `edge` was already supported alongside `experimental-edge`.
  - `next/async-params`: the glob now names the files the section lists (page, layout, route, default, opengraph-image, twitter-image, icon, apple-icon) and drops `template`, which the section does not list.
  - `next/middleware-to-proxy`: the event is `deprecated`, not `renamed`, with `replacement_since` 16. The section says the `middleware` file is deprecated, and that edge middleware should stay `middleware`.
- Matched drafts left as drafts, each with the reason in its `notes`: `the-next-server-import-for-imageresponse-was-renamed-to-next` and `fetch-requests` (the usage finder can't report the usage, or the indirect case, the rule needs), and `client-cache`, `local-images-with-query-strings-breaking-change`, `minimumcachettl-default-breaking-change`, `imagesizes-default-breaking-change`, `qualities-default-breaking-change`, `local-ip-restriction-breaking-change` and `maximum-redirects-breaking-change` (the match binds only the explicit setting or the remedy, which the change does not affect).
