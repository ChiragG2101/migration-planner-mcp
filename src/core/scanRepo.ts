// Core API for ingest and scan_repo. Adapters call these and nothing else.
import { z } from 'zod';
import { analyzeRepo, type RepoFacts } from '../analysis/scanner.js';
import { createOrReuseRun, decideVersions, readGitState, resolveRepo, singleRepoPath, type Repo } from '../pipeline/ingest.js';
import { IngestInput, type GitState, type Question, type RunRef, type Versions } from '../schema/ingest.js';
import type { ScanRepoOutput, ScanResult } from '../schema/scan.js';
import { InputError } from '../security/errors.js';
import { recordFiles, setRunStatus } from '../store/runs.js';
import { openSession, runTool, type Engine, type Session, type ToolCall } from './engine.js';

export interface IngestOutput {
  status: 'ok' | 'question';
  run: RunRef | null;
  versions: Versions | null;
  git: GitState | null;
  question: Question | null;
}

function parseInput(raw: unknown): IngestInput {
  const parsed = IngestInput.safeParse(raw);
  if (!parsed.success) throw new InputError('invalid_input', z.prettifyError(parsed.error));
  return parsed.data;
}

interface Ingested {
  input: IngestInput;
  repo: Repo;
  session: Session;
  facts: RepoFacts;
  git: GitState;
  question: Question | null;
  run: RunRef | null;
  versions: Versions | null;
}

/** Shared by ingest and scan_repo: validate, refuse what v0.1 doesn't do, then ask or create the run. */
async function withIngest<T>(engine: Engine, raw: unknown, step: string, then: (ing: Ingested, call: ToolCall) => T): Promise<T> {
  const input = parseInput(raw);
  const repo = resolveRepo(singleRepoPath(input.repo_path));
  const session = openSession(engine, repo.root);
  return runTool(engine, session, step, input, (call) => {
    const facts = analyzeRepo(repo.root, repo.repoId, engine.limits);
    const git = readGitState(repo.root, repo.repoId, facts.walk);
    const decided = decideVersions(input, facts.packages, engine.bundle);
    if ('question' in decided) {
      call.event('ingest.question', decided.question);
      return then({ input, repo, session, facts, git, question: decided.question, run: null, versions: null }, call);
    }
    const run = createOrReuseRun({ db: session.db, now: engine.now, randomBytes: engine.randomBytes }, input, repo, git, decided);
    call.attachRun(run.ref.run_id);
    call.event('ingest.run', { reused: run.reused, idem_key: run.idemKey, versions: decided.versions, pack: decided.pack?.ref ?? null, companions: decided.companions });
    return then({ input, repo, session, facts, git, question: null, run: run.ref, versions: decided.versions }, call);
  });
}

export async function ingest(engine: Engine, raw: unknown): Promise<IngestOutput> {
  return withIngest(engine, raw, 'ingest', (ing) => ({
    status: ing.question ? 'question' : 'ok',
    run: ing.run,
    versions: ing.versions,
    git: ing.question ? null : ing.git,
    question: ing.question,
  }));
}

export async function scanRepo(engine: Engine, raw: unknown): Promise<ScanRepoOutput> {
  return withIngest(engine, raw, 'scan_repo', (ing, call): ScanRepoOutput => {
    if (ing.question || !ing.run || !ing.versions) return { status: 'question', run: null, scan: null, question: ing.question };
    const { facts } = ing;
    const scan: ScanResult = {
      root: ing.repo.root,
      git: ing.git,
      versions: ing.versions,
      workspaces: facts.workspaces,
      packages: facts.packages.map((p) => ({
        ...p,
        dependencies: p.dependencies.map(({ candidates: _candidates, ...d }) => d),
      })),
      lockfiles: facts.lockfiles,
      unrecognised_manifests: facts.unrecognised,
      manifest_errors: facts.manifestErrors,
      files: { read: facts.walk.files.length, bytes: facts.walk.bytes },
      skipped: facts.walk.skipped,
      limits: engine.limits,
    };
    recordFiles(ing.session.db, ing.run.run_id, ing.repo.repoId, facts.walk.files);
    call.event('scan.result', scan);
    setRunStatus(ing.session.db, ing.run.run_id, 'scanned');
    return { status: 'ok', run: ing.run, scan, question: null };
  });
}
