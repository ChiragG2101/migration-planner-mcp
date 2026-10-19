// Maintainer tool: draft rules for one release from its official notes.
// `npm run knowledge:draft -- <ecosystem>/<library> <release>`
// It never overwrites a rule that already exists. Network is allowed here;
// src/ never imports this file.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFile, type Library } from '../src/schema/knowledge.js';
import { draftFromNotes, pageFor } from './lib/draft.js';
import { notesLocation } from './lib/release-notes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const [libraryId, release, ...rest] = process.argv.slice(2);
const notesFlag = rest.indexOf('--notes');
const notesFile = notesFlag >= 0 ? rest[notesFlag + 1] : undefined;

if (!libraryId || !release || !/^[a-z]+\/[a-z0-9][a-z0-9._-]*$/.test(libraryId) || !/^\d+(\.\d+){0,2}$/.test(release)) {
  process.stderr.write('usage: npm run knowledge:draft -- <ecosystem>/<library> <release> [--notes <file>]\n');
  process.exit(1);
}

const dir = path.join(root, 'knowledge', ...libraryId.split('/'));
const library = JSON.parse(readFileSync(path.join(dir, 'library.json'), 'utf8')) as Library;
const loc = notesLocation(library, release);
if (!loc) {
  process.stderr.write(`${libraryId} ${release} has no release notes location\n`);
  process.exit(1);
}
const notes = notesFile ? readFileSync(notesFile, 'utf8') : await fetch(loc.fetch).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${loc.fetch}`))));
const filePath = path.join(dir, 'releases', `${release}.json`);
let existing = null;
try {
  existing = ReleaseFile.parse(JSON.parse(readFileSync(filePath, 'utf8')));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}
const result = draftFromNotes(library, release, notes, pageFor(library, release), existing);
writeFileSync(filePath, `${JSON.stringify(result.file, null, 2)}\n`);
process.stdout.write(`added ${result.added.length}: ${result.added.join(', ') || 'none'}\n`);
process.stdout.write(`kept ${result.kept.length}\n`);
if (result.unknown.length) process.stderr.write(`unknown headings:\n${result.unknown.map((h) => `  ${h}`).join('\n')}\n`);
