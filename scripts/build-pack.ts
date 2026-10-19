// `npm run build:packs` writes each pack's SKILL.md and references.
// `--check` fails when a generated file differs, which is the CI drift check.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedPack } from './lib/build-pack.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const packs = readdirSync(path.join(root, 'packs')).filter((n) => n !== '.gitkeep');
let drift = false;
for (const name of packs) {
  const files = generatedPack(root, name);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, 'packs', name, rel);
    if (check) {
      let have: string | undefined;
      try {
        have = readFileSync(abs, 'utf8');
      } catch {
        have = undefined;
      }
      if (have !== text) {
        process.stderr.write(`drift: packs/${name}/${rel}\n`);
        drift = true;
      }
    } else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
}
if (drift) process.exit(1);
process.stdout.write(check ? 'pack build check passed\n' : `generated ${packs.join(', ')}\n`);
