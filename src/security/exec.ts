// C3: the only module allowed to spawn a process. In M1 it refuses everything,
// at every level; M8 implements the sandboxed runner here.
import { PermissionError } from './errors.js';

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export function exec(_req: ExecRequest): never {
  throw new PermissionError('exec_unavailable', 'execution not available');
}
