// The language adapters, by file extension. A file no adapter owns is left to
// the text scanner.
import { extensionOf, type LanguageAdapter } from './adapter.js';
import { pythonAdapter } from './python/parser.js';
import { tsAdapter } from './ts/program.js';

export const languageAdapters: readonly LanguageAdapter[] = [tsAdapter, pythonAdapter];

export function adapterFor(file: string): LanguageAdapter | null {
  const ext = extensionOf(file);
  return languageAdapters.find((a) => a.extensions.includes(ext)) ?? null;
}
