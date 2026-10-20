// Repo-untouched guard (M7 Tests: repo-untouched). A planted write during a run
// must be caught (INV-1). Replay itself never writes the repo, so this proves
// the guard fires on a bad fake planner.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRepoUntouched } from '../../../eval/engineRun.js';
import { tmpDir, writeTree } from '../../helpers.js';

describe('assertRepoUntouched', () => {
  it('passes when the fn does not write the repo', async () => {
    const root = tmpDir();
    writeTree(root, { 'a.txt': 'hello' });
    await expect(assertRepoUntouched(root, async () => 42)).resolves.toBe(42);
  });

  it('throws when a fake planner writes into the repo', async () => {
    const root = tmpDir();
    writeTree(root, { 'a.txt': 'hello' });
    await expect(
      assertRepoUntouched(root, async () => {
        writeFileSync(path.join(root, 'planted.txt'), 'oops');
      }),
    ).rejects.toThrow(/was modified during the run/);
  });
});
