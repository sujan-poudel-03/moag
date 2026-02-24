import { strict as assert } from 'assert';
import { commandExists } from '../../../utils/command-exists';

describe('commandExists', () => {
  it('should return true for a known command (node)', async () => {
    const result = await commandExists('node');
    assert.equal(result, true);
  });

  it('should return false for a nonexistent command', async () => {
    const result = await commandExists('nonexistent_cmd_xyz_99999');
    assert.equal(result, false);
  });

  it('should return false for an empty string', async () => {
    const result = await commandExists('');
    assert.equal(result, false);
  });
});
