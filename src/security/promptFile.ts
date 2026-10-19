// The versioned plan_migration prompt. It is engine data, read here so no
// other src/ file imports a filesystem read (D25). The hash in
// prompts/manifest.json is what the immutability test compares.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BUNDLED_ROOT } from './dataFiles.js';

const Manifest = z
  .object({
    current: z.string().regex(/^v\d+$/),
    prompts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();

export interface LoadedPrompt {
  version: string;
  body: string;
  hash: string;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The current prompt. The file name is `plan_migration.<version>.md`. */
export function loadPrompt(): LoadedPrompt {
  const manifest = Manifest.parse(JSON.parse(readFileSync(path.join(BUNDLED_ROOT, 'prompts', 'manifest.json'), 'utf8')));
  const version = manifest.current;
  const body = readFileSync(path.join(BUNDLED_ROOT, 'prompts', `plan_migration.${version}.md`), 'utf8');
  return { version, body, hash: sha256Text(body) };
}
