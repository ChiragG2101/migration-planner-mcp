// C5: the autonomy level is set once, at startup, from a CLI flag. Nothing a
// tool call carries can change it.
import { InputError, NotBuiltError, PermissionError } from './errors.js';

export type Level = 0 | 1;

let current: Level | null = null;

export function parseLevel(raw: string | number | undefined): Level {
  if (raw === undefined) return 0;
  const s = String(raw).trim();
  if (s === '0') return 0;
  if (s === '1') return 1;
  if (s === '2') throw new NotBuiltError('--level 2 is not built in v0.1');
  throw new InputError('bad_level', `--level must be 0 or 1, got "${s}"`);
}

/** Sets the process level. Setting it again to a different value throws. */
export function initLevel(level: Level): void {
  if (current !== null && current !== level) {
    throw new PermissionError('level', `the level is already set to ${current} and cannot change`);
  }
  current = level;
}

export function currentLevel(): Level {
  return current ?? 0;
}

export function assertLevel(required: number): void {
  const level = currentLevel();
  if (level < required) {
    throw new PermissionError('level', `this needs --level ${required}; the engine is running at level ${level}`, {
      required,
      level,
    });
  }
}
