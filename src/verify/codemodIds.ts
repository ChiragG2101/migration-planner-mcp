// The codemod IDs the core knows. Knowledge names a codemod by one of these
// IDs only (C9); the pack lint rejects any other. M8 turns this list into the
// registry that maps each ID to a pinned tool and arguments, which is the
// only place a codemod becomes a command. Adding an ID is a core change.
//
// Checked on 2026-10-19 against the official lists: nextjs.org's codemods
// guide (docs/01-app/02-guides/upgrading/codemods.mdx) and react.dev's React
// 19 upgrade guide (react-codemod, the codemod.com recipe, types-react-codemod).
export const CODEMOD_IDS = [
  // @next/codemod
  'next-codemod:upgrade',
  'next-codemod:cache-components-instant-false',
  'next-codemod:remove-partial-prefetch',
  'next-codemod:remove-experimental-ppr',
  'next-codemod:remove-unstable-prefix',
  'next-codemod:middleware-to-proxy',
  'next-codemod:next-lint-to-eslint-cli',
  'next-codemod:app-dir-runtime-config-experimental-edge',
  'next-codemod:next-async-request-api',
  'next-codemod:next-request-geo-ip',
  'next-codemod:next-og-import',
  'next-codemod:metadata-to-viewport-export',
  'next-codemod:built-in-next-font',
  'next-codemod:next-image-to-legacy-image',
  'next-codemod:next-image-experimental',
  'next-codemod:new-link',
  // react-codemod (and its React 19 recipe on codemod.com)
  'react-codemod:migration-recipe-19',
  'react-codemod:replace-reactdom-render',
  'react-codemod:replace-string-ref',
  'react-codemod:replace-act-import',
  'react-codemod:replace-use-form-state',
  'react-codemod:prop-types-typescript',
  // types-react-codemod
  'types-react-codemod:preset-19',
  'types-react-codemod:react-element-default-any-props',
  'types-react-codemod:no-implicit-ref-callback-return',
  'types-react-codemod:refobject-defaults',
] as const;

export type CodemodIdKnown = (typeof CODEMOD_IDS)[number];

export const isKnownCodemod = (id: string): boolean => (CODEMOD_IDS as readonly string[]).includes(id);
