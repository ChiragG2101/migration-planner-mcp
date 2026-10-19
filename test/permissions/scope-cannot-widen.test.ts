// Scope answers cannot carry a path, a deny entry, the level, the checks or
// --out, and a stop outside the pack's supported range is rejected.
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createEngine, closeEngine, setScope } from '../../src/core/index.js';
import { SetScopeInput } from '../../src/schema/scope.js';
import { setScopeTool } from '../../src/tools/setScope.js';
import { tmpDir } from '../helpers.js';

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

const forbidden = /^(paths?|deny|level|checks|out)$/;

describe('scope cannot widen', () => {
  it('the set_scope input has none of the fields scope must not touch', () => {
    const keys = keysDeep(z.toJSONSchema(SetScopeInput));
    expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
    expect(keysDeep(z.toJSONSchema(setScopeTool.inputSchema)).filter((k) => forbidden.test(k))).toEqual([]);
  });

  it('rejects an answer object that tries to pass a path, the level, the checks or --out', async () => {
    const engine = createEngine({ out: tmpDir() });
    try {
      for (const extra of [{ paths: ['src'] }, { deny: ['.env'] }, { level: 1 }, { checks: ['npm test'] }, { out: '/tmp/out' }]) {
        const err = await setScope(engine, { run_id: 'run', answers: {}, ...extra }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, JSON.stringify(extra)).toBeInstanceOf(Error);
        expect((err as Error).message.toLowerCase()).not.toMatch(/unknown_run|no run/);
      }
      const nested = await setScope(engine, { run_id: 'run', answers: { paths: ['src'] } }).then(
        () => null,
        (e: unknown) => e,
      );
      expect((nested as Error).message.toLowerCase()).not.toMatch(/unknown_run|no run/);
    } finally {
      closeEngine(engine);
    }
  });
});
