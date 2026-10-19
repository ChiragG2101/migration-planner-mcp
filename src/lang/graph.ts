// Cross-file binding resolution over per-file facts and resolved imports.
// It answers "where does this local name really come from?", following
// re-export chains, `export *` barrels, namespace imports and Python
// from-imports, and records each hop so indirect usages can show their path.
import type { ViaHop } from '../schema/usage.js';
import type { FileFacts, ImportBinding, ImportDecl, Ref, ResolvedImport } from './adapter.js';

export type Origin =
  /** A name exported by a module outside the repo (or not resolvable to a file). */
  | { kind: 'external'; module: string; name: string; hops: ViaHop[] }
  /** A top-level declaration in a repo file. */
  | { kind: 'local'; file: string; name: string; hops: ViaHop[] }
  /** A whole module: `import * as x`, `const x = require('m')`, Python `import a.b`. */
  | { kind: 'namespace'; module: string; file: string | null; hops: ViaHop[] }
  | { kind: 'unknown'; hops: ViaHop[] };

export interface FileEntry {
  facts: FileFacts;
  /** resolved[i] are the resolutions of facts.imports[i]. */
  resolved: ResolvedImport[][];
}

const MAX_DEPTH = 32;

export class Graph {
  private readonly memo = new Map<string, Origin>();

  constructor(private readonly files: ReadonlyMap<string, FileEntry>) {}

  facts(file: string): FileFacts | null {
    return this.files.get(file)?.facts ?? null;
  }

  /** The origin of a reference, applying its member access to namespaces (`ReactDOM.render`, `lib.getSession`). */
  refOrigin(file: string, ref: Ref): Origin {
    const o = this.resolveLocal(file, ref.binding);
    const member = ref.member?.split('.')[0] ?? null;
    if (!member) return o;
    if (o.kind === 'namespace') {
      if (o.file) {
        const inner = this.resolveExport(o.file, member);
        return { ...inner, hops: [...o.hops, ...inner.hops] };
      }
      return { kind: 'external', module: o.module, name: member, hops: o.hops };
    }
    // A default import used as a namespace: `import ReactDOM from 'react-dom'; ReactDOM.render`.
    if (o.kind === 'external' && o.name === 'default') return { ...o, name: member };
    return o;
  }

  resolveLocal(file: string, local: string, depth = 0): Origin {
    const key = `L:${file}#${local}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    const result = this.resolveLocalUncached(file, local, depth);
    this.memo.set(key, result);
    return result;
  }

  resolveExport(file: string, name: string, depth = 0): Origin {
    const key = `E:${file}#${name}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    // Guard cycles: a re-export loop resolves to unknown rather than recursing forever.
    this.memo.set(key, { kind: 'unknown', hops: [] });
    const result = this.resolveExportUncached(file, name, depth);
    this.memo.set(key, result);
    return result;
  }

  private bindingOrigin(_file: string, decl: ImportDecl, res: ResolvedImport[], b: ImportBinding, depth: number): Origin {
    const sub = res.find((r) => r.binding === b.local && r.to_file);
    if (sub?.to_file) return { kind: 'namespace', module: sub.to_module, file: sub.to_file, hops: [] };
    const target = res[0]?.to_file ?? null;
    if (b.imported === '*') return { kind: 'namespace', module: decl.spec, file: target, hops: [] };
    if (!target) return { kind: 'external', module: decl.spec, name: b.imported, hops: [] };
    // The importing file is where the reference is, so the import itself is not a hop.
    return this.resolveExport(target, b.imported, depth + 1);
  }

  private resolveLocalUncached(file: string, local: string, depth: number): Origin {
    const entry = this.files.get(file);
    if (!entry || depth > MAX_DEPTH) return { kind: 'unknown', hops: [] };
    const { facts, resolved } = entry;
    for (let i = facts.imports.length - 1; i >= 0; i--) {
      const decl = facts.imports[i]!;
      const b = decl.bindings.find((x) => x.local === local);
      if (b) return this.bindingOrigin(file, decl, resolved[i] ?? [], b, depth);
    }
    if (facts.symbols.some((s) => s.name === local)) return { kind: 'local', file, name: local, hops: [] };
    // Python `from x import *`: the name may come from x.
    for (let i = 0; i < facts.imports.length; i++) {
      const decl = facts.imports[i]!;
      const target = resolved[i]?.[0]?.to_file;
      if (target && decl.bindings.some((b) => b.local === '*')) {
        const o = this.resolveExport(target, local, depth + 1);
        if (o.kind !== 'unknown') return o;
      }
    }
    return { kind: 'unknown', hops: [] };
  }

  private resolveExportUncached(file: string, name: string, depth: number): Origin {
    const entry = this.files.get(file);
    if (!entry || depth > MAX_DEPTH) return { kind: 'unknown', hops: [] };
    const { facts, resolved } = entry;
    const exp = facts.exports.find((e) => e.exported === name);
    if (exp) {
      const inner = this.resolveLocal(file, exp.local, depth + 1);
      // A file that only re-exports an import is a hop; a declaration here is the origin itself.
      if (inner.kind === 'local' && inner.file === file) return inner;
      return { ...inner, hops: [{ file, line: exp.line, symbol: name }, ...inner.hops] };
    }
    let starCandidate: Origin | null = null;
    for (let i = 0; i < facts.imports.length; i++) {
      const decl = facts.imports[i]!;
      const target = resolved[i]?.[0]?.to_file ?? null;
      const hop: ViaHop = { file, line: decl.line, symbol: name };
      if (decl.kind === 'export_from') {
        const re = decl.reexports.find((r) => r.exported === name);
        if (!re) continue;
        if (re.imported === '*') return { kind: 'namespace', module: decl.spec, file: target, hops: [hop] };
        if (!target) return { kind: 'external', module: decl.spec, name: re.imported, hops: [hop] };
        const inner = this.resolveExport(target, re.imported, depth + 1);
        return { ...inner, hops: [hop, ...inner.hops] };
      }
      if (decl.kind === 'export_star') {
        if (target) {
          const inner = this.resolveExport(target, name, depth + 1);
          if (inner.kind !== 'unknown') return { ...inner, hops: [hop, ...inner.hops] };
        } else starCandidate ??= { kind: 'external', module: decl.spec, name, hops: [hop] };
      }
    }
    return starCandidate ?? { kind: 'unknown', hops: [] };
  }
}
