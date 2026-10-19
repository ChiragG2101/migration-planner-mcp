// A file the operator named on the CLI, such as `scope --answers`. It is not a
// repo read: the path is whatever they passed, and the engine never calls this.
import { readFileSync } from 'node:fs';

export function readOperatorFile(file: string): string {
  return readFileSync(file, 'utf8');
}
