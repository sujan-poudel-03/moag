import { strict as assert } from 'assert';
import { readParallelStages, ParallelStagesConfig } from '../../../utils/parallel-stages';

/** A VS Code-like section: inspect reports only what the user set; get falls back to the contributed default (1). */
function vscodeLike(user: Record<string, unknown>, scope: 'globalValue' | 'workspaceValue' | 'workspaceFolderValue' = 'globalValue'): ParallelStagesConfig {
  return {
    get: <T>(key: string, def?: T) => (key in user ? user[key] : (def ?? 1)) as T,
    inspect: (key: string) => (key in user ? { [scope]: user[key] } : {}),
  };
}

/** The headless shim: no inspect, get returns undefined for a key the config file does not set. */
function headless(file: Record<string, unknown>): ParallelStagesConfig {
  return { get: <T>(key: string, def?: T) => (key in file ? file[key] : def) as T };
}

describe('readParallelStages', () => {
  it('is 1 when neither key is set', () => {
    assert.equal(readParallelStages(vscodeLike({})), 1);
    assert.equal(readParallelStages(headless({})), 1);
  });

  it('reads the new key', () => {
    assert.equal(readParallelStages(vscodeLike({ parallelStages: 3 })), 3);
    assert.equal(readParallelStages(headless({ parallelStages: 3 })), 3);
  });

  it('keeps an old parallelPlaylists value working while the new key is unset', () => {
    assert.equal(readParallelStages(vscodeLike({ parallelPlaylists: 4 })), 4);
    assert.equal(readParallelStages(vscodeLike({ parallelPlaylists: 4 }, 'workspaceValue')), 4);
    assert.equal(readParallelStages(headless({ parallelPlaylists: 4 })), 4);
  });

  it('the new key wins over the old one', () => {
    assert.equal(readParallelStages(vscodeLike({ parallelStages: 2, parallelPlaylists: 6 })), 2);
    assert.equal(readParallelStages(headless({ parallelStages: 2, parallelPlaylists: 6 })), 2);
  });

  it('ignores a value that is not a number', () => {
    assert.equal(readParallelStages(vscodeLike({ parallelStages: 'many', parallelPlaylists: 2 })), 2);
    assert.equal(readParallelStages(headless({ parallelStages: null })), 1);
  });
});
