// Pack gate unit tests on fixture runs (M7 Tests: pack gate).
import { describe, expect, it } from 'vitest';
import { packGate, type BaseBand, type Host, type PackRuns } from '../../../eval/packGate.js';
import type { CaseRunRecall } from '../../../eval/metrics.js';

const host: Host = { product: 'claude-code', model: 'claude-opus-4-8' };

function runs(id: string, pairs: [number, number][]): CaseRunRecall[] {
  return pairs.map(([covered, total]) => ({ case_id: id, covered, total }));
}

/** A pack with equal 3-run counts on both sides, uniform host, and the given per-case recalls. */
function pack(name: string, engine: Record<string, [number, number][]>, baseline: Record<string, [number, number][]>, trueUsages = 10): PackRuns {
  const e = new Map<string, CaseRunRecall[]>();
  const b = new Map<string, CaseRunRecall[]>();
  const hosts: Host[] = [];
  for (const [id, p] of Object.entries(engine)) {
    e.set(id, runs(id, p));
    hosts.push(...p.map(() => host));
  }
  for (const [id, p] of Object.entries(baseline)) {
    b.set(id, runs(id, p));
    hosts.push(...p.map(() => host));
  }
  const goldenCases = new Set([...Object.keys(engine), ...Object.keys(baseline)]).size;
  return { pack: name, engine: e, baseline: b, hosts, trueUsages, goldenCases, commit_unavailable: [] };
}

const noBase = { base: null as BaseBand | null, widening: false };

describe('beat check (no base band)', () => {
  it('fails when engine worst equals baseline best', () => {
    const p = pack('p', { a: [[5, 10], [5, 10], [5, 10]], b: [[5, 10], [5, 10], [5, 10]] }, { a: [[5, 10], [5, 10], [5, 10]], b: [[5, 10], [5, 10], [5, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: false });
    expect(v.failures.some((f) => f.includes('does not beat'))).toBe(true);
  });

  it('passes when engine worst is just above baseline best', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10]], b: [[6, 10], [6, 10], [6, 10]] }, { a: [[5, 10], [5, 10], [5, 10]], b: [[5, 10], [5, 10], [5, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: false });
    expect(v.failures).toEqual([]);
  });

  it('nextjs-upgrade with no base band is not beat-checked and the regression check is skipped with a note', () => {
    const p = pack('nextjs-upgrade', { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] }, { a: [[9, 10], [9, 10], [9, 10]], b: [[9, 10], [9, 10], [9, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures).toEqual([]);
    expect(v.notes.some((n) => n.includes('beat check not enforced'))).toBe(true);
    expect(v.notes.some((n) => n.includes('regression check skipped'))).toBe(true);
  });
});

describe('regression check (base band present)', () => {
  const baseBand = (perCase: Record<string, [number, number]>): BaseBand => ({
    engineWorst: new Map(Object.entries(perCase).map(([id, [covered, total]]) => [id, { case_id: id, covered, total }])),
  });

  it('fails when engine worst over base cases falls below the base band low end', () => {
    const p = pack('p', { a: [[3, 10], [4, 10], [5, 10]], b: [[3, 10], [4, 10], [5, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10], b: [6, 10] }), widening: false, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('fell below the base band'))).toBe(true);
  });

  it('passes when engine worst holds the base band', () => {
    const p = pack('p', { a: [[6, 10], [7, 10], [8, 10]], b: [[6, 10], [7, 10], [8, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10], b: [6, 10] }), widening: false, exemptFromBeat: true });
    expect(v.failures).toEqual([]);
  });

  it('a widening PR whose new hard case lowers all-case recall does not fail the regression check', () => {
    // base cases a,b hold their band; new case c is hard. Regression uses only a,b.
    const p = pack('p', { a: [[6, 10], [7, 10], [8, 10]], b: [[6, 10], [7, 10], [8, 10]], c: [[0, 10], [0, 10], [0, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]], c: [[1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10], b: [6, 10] }), widening: true, exemptFromBeat: true });
    expect(v.failures.filter((f) => f.includes('fell below'))).toEqual([]);
  });

  it('removing a case pools the regression check over the remaining shared cases', () => {
    const p = pack('p', { a: [[6, 10], [7, 10], [8, 10]], b: [[6, 10], [7, 10], [8, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    // base band had a,b,c but c is gone at HEAD; the check uses a,b only and passes.
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10], b: [6, 10], c: [9, 10] }), widening: false, exemptFromBeat: true });
    expect(v.failures.filter((f) => f.includes('fell below'))).toEqual([]);
  });
});

describe('widening a beat-checked pack (base band present)', () => {
  const baseBand = (perCase: Record<string, [number, number]>): BaseBand => ({
    engineWorst: new Map(Object.entries(perCase).map(([id, [covered, total]]) => [id, { case_id: id, covered, total }])),
  });

  it('fails when new cases drop a non-exempt pack to/below the baseline over all cases', () => {
    const p = pack('django-upgrade', { a: [[6, 10], [6, 10], [6, 10]], c: [[0, 10], [0, 10], [0, 10]] }, { a: [[3, 10], [3, 10], [3, 10]], c: [[3, 10], [3, 10], [3, 10]] });
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10] }), widening: true, exemptFromBeat: false });
    expect(v.failures.some((f) => f.includes('does not beat the baseline over all cases'))).toBe(true);
  });

  it('the same widening of nextjs-upgrade passes, with the result shown as a note', () => {
    const p = pack('nextjs-upgrade', { a: [[6, 10], [6, 10], [6, 10]], c: [[0, 10], [0, 10], [0, 10]] }, { a: [[3, 10], [3, 10], [3, 10]], c: [[3, 10], [3, 10], [3, 10]] });
    const v = packGate({ runs: p, base: baseBand({ a: [6, 10] }), widening: true, exemptFromBeat: true });
    expect(v.failures).toEqual([]);
    expect(v.notes.some((n) => n.includes('shown, not enforced'))).toBe(true);
  });
});

describe('counts and hosts', () => {
  it('2 runs per case fails', () => {
    const p = pack('p', { a: [[6, 10], [6, 10]], b: [[6, 10], [6, 10]] }, { a: [[1, 10], [1, 10]], b: [[1, 10], [1, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('engine runs (need >= 3)'))).toBe(true);
  });

  it('one case with 4 runs while others have 3 fails', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10], [6, 10]], b: [[6, 10], [6, 10], [6, 10]] }, { a: [[1, 10], [1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('run counts differ'))).toBe(true);
  });

  it('engine and baseline run counts that differ fail', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10]], b: [[6, 10], [6, 10], [6, 10]] }, { a: [[1, 10], [1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('!= baseline runs'))).toBe(true);
  });

  it('a single case fails the >= 2 cases check', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10]] }, { a: [[1, 10], [1, 10], [1, 10]] });
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('fewer than 2 golden cases'))).toBe(true);
  });

  it('no true changed usage fails', () => {
    const p = pack('p', { a: [[0, 0], [0, 0], [0, 0]], b: [[0, 0], [0, 0], [0, 0]] }, { a: [[0, 0], [0, 0], [0, 0]], b: [[0, 0], [0, 0], [0, 0]] }, 0);
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('no true changed usage'))).toBe(true);
  });

  it('a different host model fails; a different product with the same model fails', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10]], b: [[6, 10], [6, 10], [6, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    p.hosts[0] = { product: 'claude-code', model: 'other-model' };
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('one host product and model'))).toBe(true);
    p.hosts[0] = { product: 'cursor', model: host.model };
    const v2 = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v2.failures.some((f) => f.includes('one host product and model'))).toBe(true);
  });

  it('fails closed on an unfetchable, uncached case commit', () => {
    const p = pack('p', { a: [[6, 10], [6, 10], [6, 10]], b: [[6, 10], [6, 10], [6, 10]] }, { a: [[1, 10], [1, 10], [1, 10]], b: [[1, 10], [1, 10], [1, 10]] });
    p.commit_unavailable = ['b'];
    const v = packGate({ runs: p, ...noBase, exemptFromBeat: true });
    expect(v.failures.some((f) => f.includes('case_commit_unavailable: b'))).toBe(true);
  });
});
