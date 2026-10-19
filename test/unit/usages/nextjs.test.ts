// The Next.js usage adapter: one test per usage kind, on small inline repos.
import { describe, expect, it } from 'vitest';
import { nextjsAdapter } from '../../../src/analysis/usages/nextjs.js';
import { brief, build, buildNext, ofKind } from '../../usages.js';

const H = "import { cookies, headers, draftMode } from 'next/headers';\n";

describe('Next.js adapter: request APIs (request_api)', () => {
  it('finds direct calls, aliased and namespace imports, and labels awaited ones', async () => {
    const b = await buildNext({
      'app/a.ts': `${H}export async function a() { const c = await cookies(); headers(); return draftMode(); }\n`,
      'app/b.ts': "import { cookies as c } from 'next/headers';\nimport * as nh from 'next/headers';\nexport const b = () => [c(), nh.headers()];\n",
    });
    const u = ofKind(b.usages, 'request_api');
    expect(brief(u)).toEqual([
      'app/a.ts:2 request_api next/headers.cookies',
      'app/a.ts:2 request_api next/headers.draftMode',
      'app/a.ts:2 request_api next/headers.headers',
      'app/b.ts:3 request_api next/headers.cookies',
      'app/b.ts:3 request_api next/headers.headers',
    ]);
    expect(u.find((x) => x.symbol.endsWith('cookies') && x.file === 'app/a.ts')!.labels).toEqual(['awaited']);
    expect(u.every((x) => x.match_kind === 'call' && x.module === 'next/headers' && x.confidence === 'exact')).toBe(true);
  });

  it('finds a call through a helper in another module, with the chain, and its callers transitively', async () => {
    const b = await buildNext({
      'lib/session.ts': `${H}export function getSession() {\n  return cookies().get('s');\n}\n`,
      'lib/user.ts': "import { getSession } from './session';\nexport const getUser = () => getSession();\n",
      'app/page.tsx': "import { getUser } from '../lib/user';\nexport default function Page() { return getUser(); }\n",
    });
    const u = ofKind(b.usages, 'request_api');
    expect(brief(u)).toEqual([
      'app/page.tsx:2 request_api next/headers.cookies',
      'lib/session.ts:3 request_api next/headers.cookies',
      'lib/user.ts:2 request_api next/headers.cookies',
    ]);
    const page = u.find((x) => x.file === 'app/page.tsx')!;
    expect(page.labels).toEqual(['indirect']);
    expect(page.via.map((h) => `${h.file}:${h.line} ${h.symbol}`)).toEqual([
      'lib/user.ts:2 getUser',
      'lib/user.ts:2 getSession',
      'lib/session.ts:2 getSession',
      'lib/session.ts:3 cookies',
    ]);
  });

  it('finds a wrapper re-exported through a barrel', async () => {
    const b = await buildNext({
      'lib/ua.ts': "import { headers } from 'next/headers';\nexport const userAgent = () => headers().get('user-agent');\n",
      'lib/index.ts': "export * from './ua';\n",
      'app/page.tsx': "import { userAgent } from '@/lib';\nexport default function Page() { return userAgent(); }\n",
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
    });
    const page = ofKind(b.usages, 'request_api').find((x) => x.file === 'app/page.tsx')!;
    expect(page.symbol).toBe('next/headers.headers');
    expect(page.via[0]).toEqual({ file: 'lib/index.ts', line: 1, symbol: 'userAgent' });
  });

  it('does not report a local function named like a request API, or a type position', async () => {
    const b = await buildNext({
      'app/a.ts': "function cookies() { return 1; }\nexport const x = cookies();\n",
      'app/b.ts': "import { cookies } from 'next/headers';\nexport function f(cookies: () => void) { cookies(); }\n",
    });
    expect(ofKind(b.usages, 'request_api')).toEqual([]);
  });
});

describe('Next.js adapter: file conventions', () => {
  it('request_props: params and searchParams in pages, layouts, route handlers, metadata, images and sitemaps', async () => {
    const b = await buildNext({
      'app/[slug]/page.tsx': 'export default function Page({ params, searchParams }) { return params.slug; }\nexport function generateMetadata(props) { return props.params; }\n',
      'app/[slug]/layout.tsx': 'export default function Layout({ children, params }) { return children; }\n',
      'app/api/[id]/route.ts': 'export async function GET(req, { params }) { return params; }\n',
      'app/[slug]/opengraph-image.tsx': 'export default function Image({ params, id }) { return id; }\n',
      'app/sitemap.ts': 'export default async function sitemap({ id }) { return []; }\n',
      'app/x/template.tsx': 'export default function T({ params }) { return params; }\n',
    });
    expect(brief(ofKind(b.usages, 'request_props'))).toEqual([
      'app/[slug]/layout.tsx:1 request_props params',
      'app/[slug]/opengraph-image.tsx:1 request_props id',
      'app/[slug]/opengraph-image.tsx:1 request_props params',
      'app/[slug]/page.tsx:1 request_props params',
      'app/[slug]/page.tsx:1 request_props searchParams',
      'app/[slug]/page.tsx:2 request_props params',
      'app/api/[id]/route.ts:1 request_props params',
      'app/sitemap.ts:1 request_props id',
    ]);
  });

  it('request_props: a request prop passed to a client component is labelled passed_to_client', async () => {
    const b = await buildNext({
      'app/client.tsx': "'use client';\nexport default function Client({ params }) { return params; }\n",
      'app/[slug]/layout.tsx': "import Client from '../client';\nexport default function Layout({ params }) {\n  return <Client params={params} />;\n}\n",
    });
    const pass = ofKind(b.usages, 'request_props').find((u) => u.line_start === 3)!;
    expect(pass.labels).toEqual(['passed_to_client']);
    expect(pass.via).toEqual([{ file: 'app/client.tsx', line: 1, symbol: 'Client' }]);
  });

  it('route_handler: an exported GET in a route file', async () => {
    const b = await buildNext({ 'app/api/route.ts': 'export async function GET() { return Response.json({}); }\nexport async function POST() {}\n' });
    expect(brief(ofKind(b.usages, 'route_handler'))).toEqual(['app/api/route.ts:1 route_handler GET']);
  });

  it('segment_config: segment exports in app files and `config` in pages files', async () => {
    const b = await buildNext({
      'src/app/page.tsx': "export const dynamic = 'force-static';\nexport const runtime = 'experimental-edge';\nexport const other = 1;\nexport default function P() { return null; }\n",
      'pages/old.tsx': 'export const config = { amp: true };\nexport default function Old() { return null; }\n',
    });
    expect(brief(ofKind(b.usages, 'segment_config'))).toEqual([
      'pages/old.tsx:1 segment_config config',
      'src/app/page.tsx:1 segment_config dynamic',
      'src/app/page.tsx:2 segment_config runtime',
    ]);
    // The config file kind, so a rule's config_key {file_kind: 'segment'} never binds next.config keys (D30).
    expect(new Set(ofKind(b.usages, 'segment_config').map((u) => `${u.match_kind}:${u.module}`))).toEqual(new Set(['config_key:segment']));
  });

  it('fetch_call: global fetch in server code, not in client components or the pages router, nor a local fetch', async () => {
    const b = await buildNext({
      'app/page.tsx': "export default async function P() {\n  const r = await fetch('/a', { cache: 'no-store' });\n  return fetch('/b');\n}\n",
      'app/client.tsx': "'use client';\nexport function C() { fetch('/c'); }\n",
      'pages/index.tsx': "export async function getServerSideProps() { await fetch('/d'); return { props: {} }; }\n",
      'lib/api.ts': "import fetch from 'node-fetch';\nexport const x = () => fetch('/e');\n",
    });
    const u = ofKind(b.usages, 'fetch_call');
    expect(brief(u)).toEqual(['app/page.tsx:2 fetch_call fetch', 'app/page.tsx:3 fetch_call fetch']);
    expect(u.map((x) => x.labels)).toEqual([['awaited', 'cache_option'], []]);
  });

  it('middleware and request_geo: the middleware file and geo/ip on its request', async () => {
    const b = await buildNext({
      'middleware.ts': "import { NextResponse } from 'next/server';\nexport function middleware(request) {\n  const c = request.geo?.country;\n  return NextResponse.next({ headers: { ip: request.ip } });\n}\n",
    });
    expect(brief(b.usages.filter((u) => u.kind === 'middleware' || u.kind === 'request_geo'))).toEqual([
      'middleware.ts:2 middleware middleware',
      'middleware.ts:3 request_geo NextRequest.geo',
      'middleware.ts:4 request_geo NextRequest.ip',
    ]);
  });

  it('parallel_route: a slot without default.*', async () => {
    const b = await buildNext({
      'app/@modal/page.tsx': 'export default () => null;\n',
      'app/@team/page.tsx': 'export default () => null;\n',
      'app/@team/default.tsx': 'export default () => null;\n',
    });
    expect(brief(ofKind(b.usages, 'parallel_route'))).toEqual(['app/@modal/page.tsx:1 parallel_route @modal']);
  });
});

describe('Next.js adapter: config, imports and APIs', () => {
  it('config_key: every key path of next.config, through a variable, a wrapper and a function', async () => {
    const b = await buildNext({
      'next.config.js':
        "const withX = (c) => c;\nconst nextConfig = {\n  experimental: {\n    serverComponentsExternalPackages: ['a'],\n  },\n  images: { domains: ['x.com'] },\n};\nmodule.exports = withX(nextConfig);\n",
    });
    expect(brief(ofKind(b.usages, 'config_key'))).toEqual([
      'next.config.js:3 config_key experimental',
      'next.config.js:4 config_key experimental.serverComponentsExternalPackages',
      'next.config.js:6 config_key images',
      'next.config.js:6 config_key images.domains',
    ]);
    const fn = await buildNext({ 'next.config.mjs': 'export default (phase) => ({ eslint: { ignoreDuringBuilds: true } });\n' });
    expect(brief(ofKind(fn.usages, 'config_key'))).toEqual(['next.config.mjs:1 config_key eslint', 'next.config.mjs:1 config_key eslint.ignoreDuringBuilds']);
  });

  it('config_key: reads every object Object.assign merges', async () => {
    const b = await buildNext({ 'next.config.js': "module.exports = Object.assign({}, { images: {} }, { eslint: {} });\n" });
    expect(brief(ofKind(b.usages, 'config_key'))).toEqual(['next.config.js:1 config_key eslint', 'next.config.js:1 config_key images']);
  });

  it('config_key: falls back to the text scanner, labelled heuristic, when the config is not fully static', async () => {
    const b = await buildNext({
      'next.config.js': "const base = require('./base.config');\nconst images = base.images;\nmodule.exports = {\n  ...base,\n  experimental: { ppr: true },\n};\n",
    });
    const u = ofKind(b.usages, 'config_key');
    expect(u.map((x) => `${x.line_start} ${x.symbol} ${x.confidence}`)).toEqual([
      '2 images heuristic',
      '5 experimental exact',
      '5 experimental.ppr exact',
    ]);
    const dynamic = await buildNext({ 'next.config.js': "module.exports = require('./base.config')(process.env.STAGE);\n// experimental flags live in base.config\n" });
    expect(ofKind(dynamic.usages, 'config_key').map((x) => `${x.line_start} ${x.symbol} ${x.confidence}`)).toEqual(['2 experimental heuristic']);
  });

  it('removed, renamed and internal imports, and the APIs moved in next/cache and next/server', async () => {
    const b = await buildNext({
      'app/a.tsx':
        "import { Inter } from '@next/font/google';\nimport Image from 'next/legacy/image';\nimport { useAmp } from 'next/amp';\nimport getConfig from 'next/config';\n" +
        "import { cookies } from 'next/dist/client/components/headers';\nimport { revalidateTag, unstable_cacheLife as cacheLife } from 'next/cache';\nimport { unstable_rootParams } from 'next/server';\n" +
        "export async function f() { revalidateTag('x'); cacheLife('hours'); return unstable_rootParams(); }\n",
    });
    expect(brief(b.usages.filter((u) => u.kind !== 'dependency'))).toEqual([
      'app/a.tsx:1 removed_package @next/font/google',
      'app/a.tsx:2 deprecated_import next/legacy/image',
      'app/a.tsx:3 removed_api next/amp',
      'app/a.tsx:4 runtime_config next/config',
      'app/a.tsx:5 internal_import next/dist/client/components/headers',
      'app/a.tsx:8 cache_api next/cache.revalidateTag',
      'app/a.tsx:8 removed_api next/server.unstable_rootParams',
      'app/a.tsx:8 renamed_api next/cache.unstable_cacheLife',
    ]);
  });
});

describe('Next.js adapter: React 19 changes', () => {
  it('react_removed_api and react_renamed_api: named, default and namespace forms', async () => {
    const b = await buildNext({
      'src/a.tsx':
        "import ReactDOM from 'react-dom';\nimport * as RD from 'react-dom';\nimport { findDOMNode, useFormState } from 'react-dom';\nimport React from 'react';\n" +
        'export function f(el) { ReactDOM.render(null, el); RD.hydrate(null, el); findDOMNode(el); React.createFactory("div"); return useFormState(f, 0); }\n',
    });
    expect(brief(b.usages.filter((u) => u.kind.startsWith('react_')))).toEqual([
      'src/a.tsx:5 react_removed_api react-dom.findDOMNode',
      'src/a.tsx:5 react_removed_api react-dom.hydrate',
      'src/a.tsx:5 react_removed_api react-dom.render',
      'src/a.tsx:5 react_removed_api react.createFactory',
      'src/a.tsx:5 react_renamed_api react-dom.useFormState',
    ]);
  });

  it('react_removed_import: react-dom/test-utils and react-test-renderer', async () => {
    const b = await buildNext({ 'src/a.test.tsx': "import { act } from 'react-dom/test-utils';\nimport ShallowRenderer from 'react-test-renderer/shallow';\n" });
    expect(brief(ofKind(b.usages, 'react_removed_import'))).toEqual([
      'src/a.test.tsx:1 react_removed_import react-dom/test-utils',
      'src/a.test.tsx:2 react_removed_import react-test-renderer/shallow',
    ]);
  });

  it('react_legacy: string refs, defaultProps and propTypes on function components, legacy context; not class defaultProps', async () => {
    const b = await buildNext({
      'src/Old.jsx':
        "import React from 'react';\nexport class Old extends React.Component {\n  static defaultProps = { a: 1 };\n  static contextTypes = {};\n" +
        '  render() { return <input ref="field" onFocus={() => this.refs.field} />; }\n}\n' +
        'export function Button({ label }) { return <b>{label}</b>; }\nButton.defaultProps = { label: "x" };\nButton.propTypes = {};\n',
    });
    expect(brief(ofKind(b.usages, 'react_legacy'))).toEqual([
      'src/Old.jsx:4 react_legacy legacy_context',
      'src/Old.jsx:5 react_legacy string_ref',
      'src/Old.jsx:8 react_legacy defaultProps',
      'src/Old.jsx:9 react_legacy propTypes',
    ]);
  });

  it('react_types: a type-only import of MutableRefObject, the global JSX namespace and useRef() with no argument', async () => {
    const b = await buildNext({
      'src/t.tsx':
        "import type { MutableRefObject } from 'react';\nimport { useRef } from 'react';\nexport function C(): JSX.Element {\n  const r: MutableRefObject<number> = useRef();\n  return <i />;\n}\n",
      'src/ok.tsx': "import { useRef } from 'react';\nimport type { JSX } from 'react';\nexport const D = (): JSX.Element => { useRef(null); return <i />; };\n",
    });
    const u = ofKind(b.usages, 'react_types');
    expect(brief(u)).toEqual(['src/t.tsx:3 react_types JSX', 'src/t.tsx:4 react_types react.MutableRefObject', 'src/t.tsx:4 react_types useRef()']);
    expect(u.find((x) => x.symbol === 'react.MutableRefObject')!.labels).toEqual(['type_only']);
  });
});

describe('Next.js adapter: dependencies, text and dynamic imports', () => {
  it('dependency and next_lint_script from package.json', async () => {
    const b = await build(
      {
        'package.json': JSON.stringify(
          { name: 'app', scripts: { lint: 'next lint' }, dependencies: { next: '14.2.35', react: '18.3.1', lodash: '4' }, devDependencies: { '@next/font': '14.2.0' } },
          null,
          2,
        ),
      },
      { adapter: nextjsAdapter },
    );
    expect(brief(b.usages)).toEqual([
      'package.json:4 next_lint_script next lint',
      'package.json:7 dependency next',
      'package.json:8 dependency react',
      'package.json:12 dependency @next/font',
    ]);
  });

  it('peer_dependency: every peer range on next/react/react-dom, labelled peer_conflict against a known target', async () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/old-ui': { version: '2.0.0', peerDependencies: { react: '^16 || ^17 || ^18' } },
        'node_modules/new-ui': { version: '3.0.0', peerDependencies: { react: '>=18', 'react-dom': '>=18' }, peerDependenciesMeta: { 'react-dom': { optional: true } } },
        'node_modules/next-auth': { version: '4.24.0', peerDependencies: { next: '^12 || ^13 || ^14' } },
      },
    };
    const b = await buildNext({ 'package-lock.json': JSON.stringify(lock, null, 2) }, { next: '16.0.0', react: '19.2.0' });
    const u = ofKind(b.usages, 'peer_dependency');
    expect(u.map((x) => `${x.symbol} [${x.labels.join(',')}]`)).toEqual([
      'old-ui@2.0.0 peer react@^16 || ^17 || ^18 [peer_conflict]',
      'new-ui@3.0.0 peer react-dom@>=18 [optional_peer]',
      'new-ui@3.0.0 peer react@>=18 []',
      'next-auth@4.24.0 peer next@^12 || ^13 || ^14 [peer_conflict]',
    ]);
    // Without a React target (M2 alone), the range is recorded but not judged.
    const noTarget = await buildNext({ 'package-lock.json': JSON.stringify(lock, null, 2) }, { next: '16.0.0' });
    expect(ofKind(noTarget.usages, 'peer_dependency')[0]!.labels).toEqual([]);
  });

  it('peer_dependency: a yarn v1 lockfile records no peer ranges, and the summary says so', async () => {
    const b = await buildNext({ 'yarn.lock': '# yarn lockfile v1\n\nnext@14.2.35:\n  version "14.2.35"\n' });
    expect(b.summary.peer_data_unavailable).toEqual(['yarn.lock']);
  });

  it('sass_tilde_import, by text and heuristic', async () => {
    const b = await buildNext({ 'styles/a.scss': "@import '~bootstrap/scss/bootstrap';\n@use \"sass:math\";\n" });
    const u = ofKind(b.usages, 'sass_tilde_import');
    expect(brief(u)).toEqual(['styles/a.scss:1 sass_tilde_import ~']);
    expect(u[0]!.confidence).toBe('heuristic');
  });

  it('unresolved_dynamic: a dynamic import by variable is a usage and is listed in the summary', async () => {
    const b = await buildNext({ 'app/load.ts': 'export const load = (name: string) => import(`./pages/${name}`);\n' });
    expect(brief(ofKind(b.usages, 'unresolved_dynamic'))).toEqual(['app/load.ts:1 unresolved_dynamic import(`./pages/${name}`)']);
    expect(b.summary.unresolved_dynamic).toHaveLength(1);
  });

  it('build output under .next/ is not analysed, and the summary lists it', async () => {
    const b = await buildNext({ '.next/server/app/page.js': "const { cookies } = require('next/headers');\ncookies();\n" });
    expect(ofKind(b.usages, 'request_api')).toEqual([]);
    expect(b.summary.skipped_generated).toEqual(['.next/']);
  });

  it('every emitted kind is declared, and every match kind is one the adapter declares', async () => {
    const b = await buildNext({ 'app/page.tsx': `${H}export default async function P({ params }) { await cookies(); return params; }\n` });
    for (const u of b.usages) {
      expect(nextjsAdapter.usage_kinds).toContain(u.kind);
      if (u.match_kind) expect(nextjsAdapter.match_kinds).toContain(u.match_kind);
    }
  });
});
