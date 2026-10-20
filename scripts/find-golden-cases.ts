// Golden-case finder (M7 task 8, D11, INV-41). Searches GitHub for merged PRs
// whose title names the upgrade, vets each hit with the shared checks, and
// writes candidate case.json files (status: candidate) plus a vetting report to
// eval/.work/candidates/ (gitignored). It NEVER writes into eval/cases/ and
// never adds a case automatically: a human vets candidates with the
// add-golden-case skill. Maintainer tooling: gh/git over the network, paced
// about every 7 seconds (GitHub's secondary rate limit), never in default CI,
// never imported by src/ (INV-40).
//
//   npm run cases:find -- <pack> --from <v> --to <v>
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vetCandidate, type Candidate } from '../eval/caseVet.js';

const top = (): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SEARCH_PACE_MS = 7000;

/**
 * The only directory the finder writes to: `eval/.work/candidates/` under the
 * repo top (gitignored). It is never `eval/cases/`, so the finder can never add
 * a case automatically (INV-41, D11). Exported so a test can pin this.
 */
export function candidatesDir(repoTop: string): string {
  return path.join(repoTop, 'eval', '.work', 'candidates');
}

interface SearchHit {
  repo_url: string;
  pr_url: string;
  author: { login: string; type?: string } | null;
}

/** Search merged PRs by title via gh. Separated so a test can stub it. */
async function searchPrs(query: string): Promise<SearchHit[]> {
  const out = execFileSync('gh', ['search', 'prs', '--merged', '--json', 'url,repository,author', '--limit', '30', query], { encoding: 'utf8' });
  const hits = JSON.parse(out) as { url: string; repository: { nameWithOwner: string }; author: { login: string; type?: string } | null }[];
  await sleep(SEARCH_PACE_MS);
  return hits.map((h) => ({ repo_url: `https://github.com/${h.repository.nameWithOwner}`, pr_url: h.url, author: h.author }));
}

function parseArgs(argv: string[]): { pack: string; from: string; to: string } {
  const pack = argv[0];
  const fromIdx = argv.indexOf('--from');
  const toIdx = argv.indexOf('--to');
  if (!pack || pack.startsWith('--') || fromIdx < 0 || toIdx < 0) {
    throw new Error('usage: npm run cases:find -- <pack> --from <v> --to <v>');
  }
  return { pack, from: argv[fromIdx + 1]!, to: argv[toIdx + 1]! };
}

async function main(argv: string[]): Promise<number> {
  const { pack, from, to } = parseArgs(argv);
  const library = pack.startsWith('nextjs') ? 'next' : pack.startsWith('django') ? 'django' : pack;
  const outDir = candidatesDir(top());
  mkdirSync(outDir, { recursive: true });

  // The real finder fetches commit metadata and lockfiles per hit; here we vet
  // what the search returns and record the candidate for a human to complete.
  const hits = await searchPrs(`${library} ${from} ${to} upgrade in:title`);
  let written = 0;
  for (const hit of hits) {
    const candidate: Candidate = { repo_url: hit.repo_url, base_commit: '', merge_commit: '', pr_url: hit.pr_url, source: from, target: to, license: null };
    // Vetting runs on the data the maintainer completes; the finder flags the cell to fill.
    const report = vetCandidate({
      candidate,
      author: hit.author,
      mergeParents: [],
      baseLockfile: null,
      mergeLockfile: null,
      library,
      testInfo: { hasTestScript: false, hasCiWorkflow: false },
      fetchable: { base: false, merge: false },
    });
    const slug = hit.repo_url.replace(/^https:\/\/github\.com\//, '').replace(/\//g, '-');
    writeFileSync(path.join(outDir, `${slug}.json`), `${JSON.stringify({ status: 'candidate', pack, candidate, report }, null, 2)}\n`);
    written += 1;
  }
  process.stdout.write(`wrote ${written} candidate(s) to ${path.relative(process.cwd(), outDir)} (none added to eval/cases/)\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

export { searchPrs };
