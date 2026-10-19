// The Python language adapter on test/fixtures/python-imports: absolute,
// relative, submodule and importlib imports resolve; a dotted settings string
// becomes a heuristic string_ref edge; a non-literal import_module is
// unresolved; a syntax error lists the file as unparsed without failing.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GRAMMAR_PATH } from '../../../src/lang/python/parser.js';
import { copyFixture, tmpDir } from '../../helpers.js';
import { build, type Built } from '../../usages.js';

let b: Built;
beforeAll(async () => {
  b = await build({}, { root: copyFixture('python-imports', path.join(tmpDir(), 'repo')) });
});

const edges = (from: string): string[] =>
  b.imports.filter((i) => i.from_file === from).map((i) => `${i.line} ${i.kind} ${i.to_module} -> ${i.to_file ?? 'null'} (${i.confidence})`);

describe('Python adapter', () => {
  it('loads the vendored grammar whose checksum the grammar README records', () => {
    const sha = createHash('sha256').update(readFileSync(GRAMMAR_PATH)).digest('hex');
    expect(sha).toBe('16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47');
  });

  it('resolves absolute, relative, submodule and importlib imports against the package roots', () => {
    expect(edges('src/shop/views.py')).toEqual([
      '1 import importlib -> null (exact)',
      '3 import shop.utils -> src/shop/utils.py (exact)',
      '4 import . -> src/shop/__init__.py (exact)',
      '4 import .utils -> src/shop/utils.py (exact)',
      '5 import .models -> src/shop/models.py (exact)',
      '6 import .plugins -> src/shop/plugins/__init__.py (exact)',
      '6 import .plugins.stripe -> src/shop/plugins/stripe.py (exact)',
      '10 importlib shop.plugins.stripe -> src/shop/plugins/stripe.py (exact)',
    ]);
  });

  it('records dotted settings strings as heuristic string_ref edges (a module, or a name in one), and skips file and host names', () => {
    expect(edges('src/shop/settings.py')).toEqual([
      '2 string_ref shop.middleware.AuthMiddleware -> src/shop/middleware.py (heuristic)',
      '3 string_ref django.middleware.security.SecurityMiddleware -> null (heuristic)',
      '5 string_ref shop.urls -> src/shop/__init__.py (heuristic)',
    ]);
  });

  it('records a non-literal import_module as unresolved', () => {
    expect(b.summary.unresolved_dynamic).toEqual([{ file: 'src/shop/views.py', line: 11, kind: 'importlib', expr: 'importlib.import_module(name)' }]);
  });

  it('lists a file with a syntax error as unparsed instead of failing the run', () => {
    expect(b.summary.unparsed_files).toEqual([{ file: 'src/shop/broken.py', lang: 'python', line: 4, message: expect.stringContaining('syntax error'), partial: true }]);
    expect(edges('src/shop/broken.py')).toEqual(['1 import .models -> src/shop/models.py (exact)']);
  });

  it('resolves bindings across files and scopes a parameter that shadows an import', () => {
    const g = b.ctx.graph;
    expect(g.resolveLocal('src/shop/views.py', 'order_total')).toMatchObject({ kind: 'local', file: 'src/shop/models.py', name: 'total' });
    expect(g.resolveLocal('src/shop/views.py', 'stripe_plugin')).toMatchObject({ kind: 'namespace', file: 'src/shop/plugins/stripe.py' });
    const refs = b.ctx.facts('src/shop/views.py')!.refs.filter((r) => r.binding === 'Order');
    expect(refs.map((r) => [r.line, r.ctx, r.enclosing])).toEqual([[16, 'call', 'view']]);
    const attr = b.ctx.facts('src/shop/views.py')!.refs.find((r) => r.binding === 'shop')!;
    expect([attr.member, attr.ctx]).toEqual(['utils.slugify', 'call']);
  });

  it('stores top-level symbols', () => {
    expect(b.symbols.filter((s) => s.file === 'src/shop/models.py').map((s) => `${s.name}:${s.kind}`)).toEqual(['Order:class', 'total:function']);
  });
});
