// Finds every reference whose origin is a target API, directly or through
// re-exports, and (for targets that ask for it) through wrappers: a
// top-level declaration that uses a target makes every reference to that
// declaration an indirect usage, transitively. Each indirect usage carries
// the chain from the reference down to the direct use.
import type { Ref } from '../../lang/adapter.js';
import type { Origin } from '../../lang/graph.js';
import type { ViaHop } from '../../schema/usage.js';
import type { UsageContext } from './adapter.js';

export interface TraceTarget<T> {
  /** The target this origin is, or null. */
  match(origin: Origin, ref: Ref): T | null;
  /** True when callers of a wrapper around this target are usages too. */
  followWrappers(target: T): boolean;
}

export interface TraceHit<T> {
  file: string;
  ref: Ref;
  target: T;
  /** Re-export hops, then wrapper hops down to the direct use; empty for a plain direct use. */
  via: ViaHop[];
  /** Reached through a wrapper declaration (not only re-exports). */
  throughWrapper: boolean;
}

interface Taint<T> {
  target: T;
  /** From the wrapper's declaration down to the direct use. */
  via: ViaHop[];
}

export function traceUses<T>(ctx: UsageContext, spec: TraceTarget<T>): TraceHit<T>[] {
  const hits: TraceHit<T>[] = [];
  const tainted = new Map<string, Taint<T>>();
  const declLine = (file: string, name: string): number => ctx.facts(file)?.symbols.find((s) => s.name === name)?.line ?? 1;
  const taint = (file: string, name: string | null, t: Taint<T>): boolean => {
    if (name === null) return false;
    const key = `${file}#${name}`;
    if (tainted.has(key)) return false;
    tainted.set(key, t);
    return true;
  };

  const all: { file: string; ref: Ref; origin: Origin }[] = [];
  for (const file of ctx.files) {
    for (const ref of ctx.facts(file)?.refs ?? []) all.push({ file, ref, origin: ctx.graph.refOrigin(file, ref) });
  }

  // Direct uses (possibly through re-export hops).
  for (const { file, ref, origin } of all) {
    const target = spec.match(origin, ref);
    if (target === null) continue;
    hits.push({ file, ref, target, via: origin.hops, throughWrapper: false });
    if (spec.followWrappers(target) && ref.ctx !== 'type' && ref.enclosing) {
      taint(file, ref.enclosing, {
        target,
        via: [{ file, line: declLine(file, ref.enclosing), symbol: ref.enclosing }, ...origin.hops, { file, line: ref.line, symbol: ref.binding }],
      });
    }
  }

  // Wrappers, to a fixed point: a reference to a tainted declaration is a usage and taints its own enclosing declaration.
  const seen = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { file, ref, origin } of all) {
      if (origin.kind !== 'local' || ref.ctx === 'type') continue;
      const t = tainted.get(`${origin.file}#${origin.name}`);
      if (!t) continue;
      if (origin.file === file && ref.enclosing === origin.name) continue; // recursion inside the wrapper
      const key = `${file}:${ref.line}:${ref.binding}:${ref.member ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const via = [...origin.hops, ...t.via];
      hits.push({ file, ref, target: t.target, via, throughWrapper: true });
      if (ref.enclosing && taint(file, ref.enclosing, { target: t.target, via: [{ file, line: declLine(file, ref.enclosing), symbol: ref.enclosing }, { file, line: ref.line, symbol: ref.binding }, ...via] })) {
        changed = true;
      }
    }
  }
  return hits;
}
