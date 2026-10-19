// INV-12 (C2): SQLite is reached only through src/store/, and there is no other
// database or vector-store dependency.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers.js';
import { allImports } from '../static.js';

const dbModules = new Set(['node:sqlite', 'sqlite', 'better-sqlite3']);
const otherDbs =
  /^(@?prisma|pg|postgres|mysql2?|mongodb|mongoose|redis|ioredis|sqlite3|knex|typeorm|sequelize|drizzle-orm|@lancedb\/.*|chromadb|@pinecone-database\/.*|weaviate.*|@qdrant\/.*|faiss.*|hnswlib.*|vectordb|@zilliz\/.*|lowdb|nedb|level|leveldown)$/;

describe('store only', () => {
  it('imports node:sqlite and better-sqlite3 only under src/store/', () => {
    const offenders = allImports().filter((u) => dbModules.has(u.module) && !u.file.startsWith('src/store/'));
    expect(offenders).toEqual([]);
  });

  it('the store does import node:sqlite (so the check above is not vacuous)', () => {
    expect(allImports().some((u) => u.module === 'node:sqlite' && u.file.startsWith('src/store/'))).toBe(true);
  });

  it('package.json has no other database or vector-store dependency', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => otherDbs.test(d))).toEqual([]);
  });
});
