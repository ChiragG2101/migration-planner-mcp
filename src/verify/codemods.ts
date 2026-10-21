// Codemod registry (M8, C9). Maps every known codemod ID to a pinned tool and
// argv template. This is the ONLY place a codemod ID becomes a runnable command.
// Knowledge names codemods by ID only; the pack lint rejects any other field.
// Adding an entry is a core change (checked by scripts/check-core-untouched.ts, M10).
import type { CodemodEntry } from '../schema/verify.js';
import { CODEMOD_IDS, type CodemodIdKnown } from './codemodIds.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Pinned versions — bumped only when the upstream codemod has a verified release.
// `{sandbox}` in argv_template is replaced with the sandbox root at run time.
const REGISTRY: Record<CodemodIdKnown, Omit<CodemodEntry, 'id'>> = {
  'next-codemod:upgrade': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'upgrade', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:cache-components-instant-false': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'cache-components-instant-false', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:remove-partial-prefetch': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'remove-partial-prefetch', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:remove-experimental-ppr': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'remove-experimental-ppr', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:remove-unstable-prefix': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'remove-unstable-prefix', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:middleware-to-proxy': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'middleware-to-proxy', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-lint-to-eslint-cli': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-lint-to-eslint-cli', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:app-dir-runtime-config-experimental-edge': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'app-dir-runtime-config-experimental-edge', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-async-request-api': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-async-request-api', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-request-geo-ip': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-request-geo-ip', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-og-import': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-og-import', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:metadata-to-viewport-export': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'metadata-to-viewport-export', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:built-in-next-font': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'built-in-next-font', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-image-to-legacy-image': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-image-to-legacy-image', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:next-image-experimental': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'next-image-experimental', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'next-codemod:new-link': {
    runner: 'npx',
    package: '@next/codemod',
    version: '15.3.3',
    argv_template: ['npx', '@next/codemod@15.3.3', 'new-link', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:migration-recipe-19': {
    runner: 'npx',
    package: 'codemod',
    version: '0.4.4',
    argv_template: ['npx', 'codemod@0.4.4', 'react/19/migration-recipe', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:replace-reactdom-render': {
    runner: 'npx',
    package: 'react-codemod',
    version: '3.0.0',
    argv_template: ['npx', 'react-codemod@3.0.0', 'replace-reactdom-render', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:replace-string-ref': {
    runner: 'npx',
    package: 'react-codemod',
    version: '3.0.0',
    argv_template: ['npx', 'react-codemod@3.0.0', 'replace-string-ref', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:replace-act-import': {
    runner: 'npx',
    package: 'react-codemod',
    version: '3.0.0',
    argv_template: ['npx', 'react-codemod@3.0.0', 'replace-act-import', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:replace-use-form-state': {
    runner: 'npx',
    package: 'react-codemod',
    version: '3.0.0',
    argv_template: ['npx', 'react-codemod@3.0.0', 'replace-use-form-state', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'react-codemod:prop-types-typescript': {
    runner: 'npx',
    package: 'react-codemod',
    version: '3.0.0',
    argv_template: ['npx', 'react-codemod@3.0.0', 'prop-types-typescript', '{sandbox}'],
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  'types-react-codemod:preset-19': {
    runner: 'npx',
    package: 'types-react-codemod',
    version: '1.4.1',
    argv_template: ['npx', 'types-react-codemod@1.4.1', 'preset-19', '{sandbox}'],
    languages: ['ts', 'tsx'],
  },
  'types-react-codemod:react-element-default-any-props': {
    runner: 'npx',
    package: 'types-react-codemod',
    version: '1.4.1',
    argv_template: ['npx', 'types-react-codemod@1.4.1', 'react-element-default-any-props', '{sandbox}'],
    languages: ['ts', 'tsx'],
  },
  'types-react-codemod:no-implicit-ref-callback-return': {
    runner: 'npx',
    package: 'types-react-codemod',
    version: '1.4.1',
    argv_template: ['npx', 'types-react-codemod@1.4.1', 'no-implicit-ref-callback-return', '{sandbox}'],
    languages: ['ts', 'tsx'],
  },
  'types-react-codemod:refobject-defaults': {
    runner: 'npx',
    package: 'types-react-codemod',
    version: '1.4.1',
    argv_template: ['npx', 'types-react-codemod@1.4.1', 'refobject-defaults', '{sandbox}'],
    languages: ['ts', 'tsx'],
  },
};

// Compile-time exhaustiveness: this will error if CODEMOD_IDS has an entry not in REGISTRY.
const _exhaustive: Record<CodemodIdKnown, unknown> = REGISTRY;
void _exhaustive;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a codemod entry by ID. Returns undefined for unknown IDs. */
export function getCodemodEntry(id: string): CodemodEntry | undefined {
  if (!CODEMOD_IDS.includes(id as CodemodIdKnown)) return undefined;
  const entry = REGISTRY[id as CodemodIdKnown];
  if (!entry) return undefined;
  return { id, ...entry };
}

/** Build the concrete argv for a codemod entry, replacing `{sandbox}` with the sandbox root. */
export function buildCodemodArgv(entry: CodemodEntry, sandboxRoot: string): string[] {
  return entry.argv_template.map((t) => t.replace('{sandbox}', sandboxRoot));
}

/** All registered entries. */
export function allCodemodEntries(): CodemodEntry[] {
  return (CODEMOD_IDS as readonly string[]).map((id) => ({ id, ...REGISTRY[id as CodemodIdKnown]! }));
}
