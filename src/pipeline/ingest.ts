// Ingest: one repo, a named source and target, the installed version from
// lockfiles only, git state read from files (never by running git), and a run
// ID under a campaign and repo ID. Vague or ambiguous input gets a question,
// never a guess.
import { createHash } from 'node:crypto';
import type { Candidate, PackageFacts, Walk } from '../analysis/scanner.js';
import { normalizePyName } from '../analysis/manifests/python.js';
import type { GitState, IngestInput, Question, RunRef, Versions } from '../schema/ingest.js';
import { NotBuiltError } from '../security/errors.js';
import { resolveInside, resolveRepoRoot } from '../security/pathBoundary.js';
import { readText } from '../security/safeRead.js';
import { ensureCampaign, ensureRepo } from '../store/campaigns.js';
import type { Db } from '../store/db.js';
import { findRunByIdemKey, insertRun } from '../store/runs.js';

/** Pack and prompt versions join the idempotency key once they exist (M3, M5). */
export const PACK_VERSION = 'none';
export const PROMPT_VERSION = 'none';

export function singleRepoPath(repoPath: string | readonly string[]): string {
  if (typeof repoPath === 'string') return repoPath;
  if (repoPath.length > 1) throw new NotBuiltError('multi-repo campaigns not built in v0.1');
  return repoPath[0]!;
}

export interface Repo {
  root: string;
  repoId: string;
}

export function repoIdFor(realpath: string): string {
  return createHash('sha256').update(realpath).digest('hex').slice(0, 16);
}

export function resolveRepo(repoPath: string): Repo {
  const root = resolveRepoRoot(repoPath);
  return { root, repoId: repoIdFor(root) };
}

const shaRe = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Reads HEAD and refs as files. Dirty state is always "unknown" (docs/design.md D20). */
export function readGitState(root: string, repoId: string, walk: Walk): GitState {
  const tryRead = (rel: string): string | null => {
    try {
      return readText(resolveInside(root, rel, repoId));
    } catch {
      return null;
    }
  };
  const isRepo = walk.skipped.some((s) => s.path === '.git/' || s.path === '.git');
  const head = isRepo ? tryRead('.git/HEAD')?.trim() ?? null : null;
  if (!head) return { is_repo: isRepo, head_ref: null, head_commit: null, dirty: 'unknown' };
  if (shaRe.test(head)) return { is_repo: true, head_ref: null, head_commit: head, dirty: 'unknown' };
  const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1] ?? null;
  let commit: string | null = null;
  if (ref) {
    const loose = tryRead(`.git/${ref}`)?.trim();
    if (loose && shaRe.test(loose)) commit = loose;
    else {
      for (const line of (tryRead('.git/packed-refs') ?? '').split(/\r?\n/)) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref && sha && shaRe.test(sha)) commit = sha;
      }
    }
  }
  return { is_repo: true, head_ref: ref, head_commit: commit, dirty: 'unknown' };
}

const question = (kind: Question['kind'], field: string, message: string, candidates: Question['candidates'] = []): { question: Question } => ({
  question: { kind, field, message, candidates },
});

/** A user-given version matches when each of its parts equals the resolved one's: "14" and "14.2" match "14.2.35". */
function versionMatches(given: string, resolved: string): boolean {
  const g = given.replace(/^(v|==)/, '').split('.');
  const r = resolved.split('.');
  return g.every((part, i) => part === r[i]);
}

export type Decision = { versions: Versions; sources: Candidate[] } | { question: Question };

/** Checks the source and target and resolves the installed source version from lockfiles. */
export function decideVersions(input: IngestInput, packages: readonly PackageFacts[]): Decision {
  const { source, target } = input;
  if (!source?.name) return question('vague_input', 'source.name', 'Name the library you are upgrading from, for example "next" or "django".');
  if (!target?.name) return question('vague_input', 'target.name', 'Name the library you are upgrading to, for example "next" or "django".');
  if (!target.version) return question('vague_input', 'target.version', `Give the target version of ${target.name}, for example ${target.name}@<version>.`);

  // Known means declared in this repo's manifests; M3 adds the pack check on top (docs/design.md D20).
  const same = (eco: PackageFacts['ecosystem'], a: string, b: string): boolean =>
    eco === 'python' ? normalizePyName(a) === normalizePyName(b) : a === b;
  const declaring = (name: string): PackageFacts[] => packages.filter((p) => p.dependencies.some((d) => same(p.ecosystem, d.name, name)));
  for (const [field, name] of [['source.name', source.name], ['target.name', target.name]] as const) {
    if (!declaring(name).length) {
      return question('vague_input', field, `"${name}" is not a dependency declared in this repo's manifests. Name a library the repo uses.`);
    }
  }

  const found: Candidate[] = [];
  for (const p of declaring(source.name)) {
    for (const d of p.dependencies) {
      if (!same(p.ecosystem, d.name, source.name)) continue;
      for (const c of d.candidates) found.push({ version: c.version, where: `${c.where} (package ${p.path})` });
    }
  }
  const byVersion = new Map<string, Set<string>>();
  for (const c of found) {
    if (!byVersion.has(c.version)) byVersion.set(c.version, new Set());
    byVersion.get(c.version)!.add(c.where);
  }
  const candidates = [...byVersion].map(([value, where]) => ({ value, where: [...where].sort() })).sort((a, b) => (a.value < b.value ? -1 : 1));
  if (candidates.length === 0) {
    return question(
      'unresolved_version',
      'source.version',
      `No lockfile pins ${source.name}. The installed version is read from lockfiles only (package-lock.json, pnpm-lock.yaml, yarn.lock, uv.lock, poetry.lock or a pinned requirements file).`,
    );
  }
  if (candidates.length > 1) {
    return question('ambiguous_version', 'source.version', `Lockfiles disagree on the installed ${source.name} version. Which package is being upgraded?`, candidates);
  }
  const installed = candidates[0]!.value;
  if (source.version && !versionMatches(source.version, installed)) {
    return question(
      'version_mismatch',
      'source.version',
      `You gave ${source.name} ${source.version}, but the lockfile pins ${installed}. The lockfile is the source of truth; check the input.`,
      [...candidates, { value: source.version, where: ['input'] }],
    );
  }
  return {
    versions: { source: { name: source.name, version: installed }, target: { name: target.name, version: target.version } },
    sources: found,
  };
}

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID from a millisecond clock and 10 random bytes (both injected, so tests are deterministic). */
export function ulid(ms: number, random: Uint8Array): string {
  let time = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    time = crockford[n % 32]! + time;
    n = Math.floor(n / 32);
  }
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of random.subarray(0, 10)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += crockford[(acc >> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}

export function idemKey(root: string, git: GitState, versions: Versions): string {
  const parts = [
    root,
    git.head_commit ?? 'unknown',
    `${versions.source.name}@${versions.source.version}`,
    `${versions.target.name}@${versions.target.version}`,
    PACK_VERSION,
    PROMPT_VERSION,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface RunDeps {
  db: Db;
  now: () => Date;
  randomBytes: (n: number) => Uint8Array;
}

/** Creates the run, or returns the existing run for the same idempotency key. */
export function createOrReuseRun(
  deps: RunDeps,
  input: IngestInput,
  repo: Repo,
  git: GitState,
  decided: { versions: Versions; sources: Candidate[] },
): { ref: RunRef; reused: boolean; idemKey: string } {
  const key = idemKey(repo.root, git, decided.versions);
  const existing = findRunByIdemKey(deps.db, key);
  if (existing) return { ref: { run_id: existing.id, campaign_id: existing.campaign_id, repo_id: existing.repo_id }, reused: true, idemKey: key };
  const now = deps.now();
  const ts = now.toISOString();
  const campaignId = input.campaign_id ?? ulid(now.getTime(), deps.randomBytes(10));
  const runId = ulid(now.getTime(), deps.randomBytes(10));
  ensureCampaign(deps.db, campaignId, ts);
  ensureRepo(deps.db, repo.repoId, campaignId, repo.root);
  insertRun(deps.db, {
    id: runId,
    campaign_id: campaignId,
    repo_id: repo.repoId,
    created_at: ts,
    input_json: JSON.stringify(input),
    versions_json: JSON.stringify({ ...decided.versions, source_resolved_from: decided.sources, git }),
    idem_key: key,
    status: 'ingested',
  });
  return { ref: { run_id: runId, campaign_id: campaignId, repo_id: repo.repoId }, reused: false, idemKey: key };
}
