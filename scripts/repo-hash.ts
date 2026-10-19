// A deterministic hash of everything under a root: every file, folder and
// symlink, ignoring .gitignore, skipping .git/objects for speed. Used to prove
// the target repo is unchanged (INV-1). Usage: npx tsx scripts/repo-hash.ts <root>
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function repoHash(root: string): string {
  const hash = createHash('sha256');
  const walk = (rel: string): void => {
    const names = readdirSync(path.join(root, rel)).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === '.git/objects' || r.endsWith('/.git/objects')) continue;
      const abs = path.join(root, r);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        hash.update(`L\0${r}\0${readlinkSync(abs)}\0`);
      } else if (st.isDirectory()) {
        hash.update(`D\0${r}\0`);
        walk(r);
      } else if (st.isFile()) {
        const content = createHash('sha256').update(readFileSync(abs)).digest('hex');
        hash.update(`F\0${r}\0${st.mode & 0o777}\0${content}\0`);
      } else {
        hash.update(`O\0${r}\0`);
      }
    }
  };
  walk('');
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: repo-hash <root>\n');
    process.exit(2);
  }
  process.stdout.write(`${repoHash(root)}\n`);
}
