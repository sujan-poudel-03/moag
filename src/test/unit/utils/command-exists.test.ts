import { strict as assert } from 'assert';
import { commandExists } from '../../../utils/command-exists';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

describe('commandExists', () => {
  it('should return true for a known command (node)', async function () {
    let result: boolean;
    try {
      result = await commandExists('node');
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(result, true);
  });

  it('should return false for a nonexistent command', async function () {
    let result: boolean;
    try {
      result = await commandExists('nonexistent_cmd_xyz_99999');
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); return; }
      throw err;
    }
    assert.equal(result, false);
  });

  it('should return false for an empty string', async () => {
    const result = await commandExists('');
    assert.equal(result, false);
  });
});
