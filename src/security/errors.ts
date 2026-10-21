// Typed refusals. Adapters turn these into MCP errors or CLI exit codes, and
// the tool wrapper records them as `tool.error` events.

export type PermissionCode =
  | 'outside_root'
  | 'denied'
  | 'forged_path'
  | 'write_outside_out'
  | 'write_inside_repo'
  | 'out_inside_repo'
  | 'level'
  | 'exec_unavailable'
  | 'exec_outside_sandbox'
  | 'unlisted_argv'
  | 'sandbox_inside_repo'
  | 'dirty_tree'
  | 'patch_escape'
  | 'network';

export class PermissionError extends Error {
  override readonly name = 'PermissionError';
  constructor(
    readonly code: PermissionCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A feature the plan defers past v0.1 (level 2, multi-repo campaigns). */
export class NotBuiltError extends Error {
  override readonly name = 'NotBuiltError';
  readonly code = 'not_built';
  constructor(message: string) {
    super(message);
  }
}

/** Bad input that is not a permission issue (missing repo, malformed flag). */
export class InputError extends Error {
  override readonly name = 'InputError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
