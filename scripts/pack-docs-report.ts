// Maintainer tool: compare a pack's rules with the live official notes.
// `npm run pack:report -- <pack>`. Output is not committed; it is printed and,
// when .private/ exists, written there for the maintainer (D29).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFile, type Library } from '../src/schema/knowledge.js';
import { Pack } from '../src/schema/pack.js';
import type { LoadedLibrary } from '../src/rules/compose.js';
import { buildReport, formatReport, type SeededCase } from './lib/report.js';
import { notesLocation } from './lib/release-notes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const [packName] = process.argv.slice(2);
if (!packName) {
  process.stderr.write('usage: npm run pack:report -- <pack>\n');
  process.exit(1);
}

const pack = Pack.parse(JSON.parse(readFileSync(path.join(root, 'packs', packName, 'pack.json'), 'utf8')));
const libs = new Map<string, LoadedLibrary>();
const files: ReleaseFile[] = [];
for (const ref of pack.libraries) {
  const dir = path.join(root, 'knowledge', ...ref.id.split('/'));
  const library = JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')) as Library;
  const releasesDir = path.join(dir, 'releases');
    const releases: { release: string; rules: Extract<ReleaseFile['rules'][number], { status: 'reviewed' }>[]; events: ReleaseFile['events'] }[] = [];
  if (existsSync(releasesDir)) {
    for (const name of readdirSync(releasesDir).filter((n) => n.endsWith('.json')).sort()) {
      const file = ReleaseFile.parse(JSON.parse(readFileSync(path.join(releasesDir, name), 'utf8')));
      files.push(file);
      releases.push({ release: file.release, rules: file.rules.filter((r) => r.status === 'reviewed'), events: file.events });
    }
  }
  libs.set(ref.id, { library, releases });
}

const notes = new Map<string, string>();
for (const lib of libs.values()) {
  for (const rel of lib.releases) {
    const loc = notesLocation(lib.library, rel.release);
    if (!loc) continue;
    const res = await fetch(loc.fetch);
    if (!res.ok) throw new Error(`${res.status} fetching ${loc.fetch}`);
    notes.set(`${lib.library.id}@${rel.release}`, await res.text());
  }
}

const seededPath = path.join(root, 'eval', 'seeded', pack.seeded, 'ground_truth.json');
const seeded = existsSync(seededPath) ? (JSON.parse(readFileSync(seededPath, 'utf8')) as { entries: SeededCase[] }).entries : [];
const text = formatReport(pack.name, buildReport(pack, libs, notes, files, seeded));
process.stdout.write(`${text}\n`);
const priv = path.join(root, '.private');
if (existsSync(priv)) {
  mkdirSync(priv, { recursive: true });
  const out = path.join(priv, `pack-report-${pack.name}.md`);
  writeFileSync(out, text);
  process.stderr.write(`wrote ${out}\n`);
}
