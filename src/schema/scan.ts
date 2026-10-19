// The scan_repo result: repo facts, with every skipped file listed and why.
import { z } from 'zod';
import { GitState, Question, RunRef, Versions } from './ingest.js';

export const Confidence = z.enum(['exact', 'heuristic']);

export const SkipReason = z.enum(['outside_root', 'denied', 'too_large', 'max_files', 'max_total_bytes', 'unreadable']);
export type SkipReason = z.infer<typeof SkipReason>;

export const Skipped = z.object({ path: z.string(), reason: SkipReason });
export type Skipped = z.infer<typeof Skipped>;

export const Dependency = z.object({
  name: z.string(),
  kind: z.enum(['prod', 'dev', 'peer', 'optional']),
  declared: z.string().nullable().describe('The declared range or specifier, as written.'),
  declared_in: z.string(),
  resolved: z.string().nullable().describe('The version the lockfile pins, if exactly one does.'),
  resolved_from: z.array(z.string()),
});
export type Dependency = z.infer<typeof Dependency>;

export const Entrypoint = z.object({
  kind: z.string(),
  path: z.string().nullable(),
  value: z.string().nullable(),
  source: z.string().describe('Where it was found: a manifest field or a marker file.'),
  confidence: Confidence,
});
export type Entrypoint = z.infer<typeof Entrypoint>;

export const TestSetup = z.object({
  runners: z.array(z.object({ name: z.string(), evidence: z.array(z.string()) })),
  globs: z.array(z.string()),
  test_script: z.string().nullable().describe('The test script as text. It is never executed.'),
});
export type TestSetup = z.infer<typeof TestSetup>;

export const TsConfigInfo = z.object({
  chain: z.array(z.string()),
  unresolved_extends: z.array(z.string()),
  module: z.string().nullable(),
  target: z.string().nullable(),
  paths: z.record(z.string(), z.array(z.string())),
});
export type TsConfigInfo = z.infer<typeof TsConfigInfo>;

export const Package = z.object({
  path: z.string().describe('Package folder relative to the repo root; "." is the root.'),
  ecosystem: z.enum(['node', 'python']),
  name: z.string().nullable(),
  manifests: z.array(z.string()),
  workspace_member: z.boolean(),
  dependencies: z.array(Dependency),
  entrypoints: z.array(Entrypoint),
  tests: TestSetup,
  tsconfig: TsConfigInfo.nullable(),
  python_tools: z.record(z.string(), z.unknown()).nullable().describe('pyproject [tool.*] sections relevant to tests and typing.'),
});
export type Package = z.infer<typeof Package>;

export const Workspace = z.object({
  kind: z.enum(['npm', 'yarn', 'pnpm', 'uv']),
  manifest: z.string(),
  patterns: z.array(z.string()),
});
export type Workspace = z.infer<typeof Workspace>;

export const Lockfile = z.object({
  path: z.string(),
  kind: z.enum(['npm', 'pnpm', 'yarn', 'uv', 'poetry', 'requirements']),
});
export type Lockfile = z.infer<typeof Lockfile>;

export const ScanLimits = z.object({
  max_files: z.number().int().positive(),
  max_file_bytes: z.number().int().positive(),
  max_total_bytes: z.number().int().positive(),
});
export type ScanLimits = z.infer<typeof ScanLimits>;

export const ScanResult = z.object({
  root: z.string(),
  git: GitState,
  versions: Versions,
  workspaces: z.array(Workspace),
  packages: z.array(Package),
  lockfiles: z.array(Lockfile),
  unrecognised_manifests: z.array(z.string()).describe('Manifests the engine does not parse (setup.py, setup.cfg, Pipfile); reported, not guessed.'),
  manifest_errors: z.array(z.object({ path: z.string(), message: z.string() })),
  files: z.object({ read: z.number().int(), bytes: z.number().int() }),
  skipped: z.array(Skipped),
  limits: ScanLimits,
});
export type ScanResult = z.infer<typeof ScanResult>;

export const ScanRepoOutput = z.object({
  status: z.enum(['ok', 'question']),
  run: RunRef.nullable(),
  scan: ScanResult.nullable(),
  question: Question.nullable(),
});
export type ScanRepoOutput = z.infer<typeof ScanRepoOutput>;
