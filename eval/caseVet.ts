// Pure vetting checks the golden-case finder and re-checker share (M7 task 8,
// D11). No network here: the scripts fetch the GitHub data and pass it in, so a
// fixture test can exercise every check offline (plan Tests). Outside the
// engine (INV-40).

/** The open-licence allowlist (SPDX ids). A committed case must carry one (plan task 2). */
export const OPEN_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'LGPL-3.0', 'GPL-3.0', 'AGPL-3.0'] as const;

export function licenseAllowed(spdx: string | null | undefined): boolean {
  return spdx !== null && spdx !== undefined && (OPEN_LICENSES as readonly string[]).includes(spdx);
}

/** A PR looks like a bot's when its author is a bot or a known bot login. */
export function isBotAuthor(author: { login: string; type?: string } | null | undefined): boolean {
  if (!author) return false;
  if (author.type === 'Bot') return true;
  return /\[bot\]$/i.test(author.login) || /^(dependabot|renovate|greenkeeper|snyk-bot)$/i.test(author.login);
}

/** The base commit must be the merge commit's first (or only) parent. */
export function parentageHolds(baseCommit: string, mergeParents: readonly string[]): boolean {
  return mergeParents.length > 0 && mergeParents[0] === baseCommit;
}

/**
 * Read a library's version from a lockfile's parsed dependency map. Returns the
 * version string, or null when the lockfile has no pin. The caller supplies the
 * parsed map (never the PR title, D11).
 */
export function versionFromLockfile(deps: Record<string, string> | null | undefined, library: string): string | null {
  if (!deps) return null;
  return deps[library] ?? null;
}

export interface VersionCheck {
  ok: boolean;
  reason: string;
}

/** The from/to the lockfile shows must match the record, read at base and merge. */
export function versionsMatch(
  record: { source: string; target: string },
  lockfile: { baseVersion: string | null; mergeVersion: string | null },
): VersionCheck {
  if (lockfile.baseVersion === null) return { ok: false, reason: 'no source version pinned in the base lockfile' };
  if (lockfile.mergeVersion === null) return { ok: false, reason: 'no target version pinned in the merge lockfile' };
  if (!lockfile.baseVersion.startsWith(record.source) && record.source !== lockfile.baseVersion) {
    return { ok: false, reason: `base lockfile version ${lockfile.baseVersion} does not match record source ${record.source}` };
  }
  if (!lockfile.mergeVersion.startsWith(record.target) && record.target !== lockfile.mergeVersion) {
    return { ok: false, reason: `merge lockfile version ${lockfile.mergeVersion} does not match record target ${record.target}` };
  }
  return { ok: true, reason: 'versions match the lockfiles' };
}

/** A test script or CI workflow must exist at base (so M8 can reuse the case). */
export function hasTestAtBase(info: { hasTestScript: boolean; hasCiWorkflow: boolean }): boolean {
  return info.hasTestScript || info.hasCiWorkflow;
}

export interface Candidate {
  repo_url: string;
  base_commit: string;
  merge_commit: string;
  pr_url: string;
  source: string;
  target: string;
  license: string | null;
}

export interface VetReport {
  pass: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface VetInput {
  candidate: Candidate;
  author: { login: string; type?: string } | null;
  mergeParents: string[];
  baseLockfile: Record<string, string> | null;
  mergeLockfile: Record<string, string> | null;
  library: string;
  testInfo: { hasTestScript: boolean; hasCiWorkflow: boolean };
  fetchable: { base: boolean; merge: boolean };
}

/** Run every vetting check and report, pass only when all hold. */
export function vetCandidate(input: VetInput): VetReport {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

  add('not a bot PR', !isBotAuthor(input.author), input.author ? `author ${input.author.login}` : 'no author');
  add('open licence', licenseAllowed(input.candidate.license), `licence ${input.candidate.license ?? 'none'}`);
  add('base is merge first parent', parentageHolds(input.candidate.base_commit, input.mergeParents), `parents ${input.mergeParents.join(', ') || 'none'}`);
  add('base commit fetchable', input.fetchable.base, input.candidate.base_commit);
  add('merge commit fetchable', input.fetchable.merge, input.candidate.merge_commit);
  const v = versionsMatch(
    { source: input.candidate.source, target: input.candidate.target },
    { baseVersion: versionFromLockfile(input.baseLockfile, input.library), mergeVersion: versionFromLockfile(input.mergeLockfile, input.library) },
  );
  add('lockfile shows the version change', v.ok, v.reason);
  add('test or CI at base', hasTestAtBase(input.testInfo), `test script ${input.testInfo.hasTestScript}, CI ${input.testInfo.hasCiWorkflow}`);

  return { pass: checks.every((c) => c.ok), checks };
}
