import { strict as assert } from 'assert';
import { EngineId } from '../../models/types';
import { EngineAvailability } from '../../adapters/engine';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

/** Helper: create a stub for checkEngineAvailability that returns controlled results. */
function makeStub(available: Record<string, boolean>) {
  return {
    checkEngineAvailability: async (ids: EngineId[]): Promise<Map<EngineId, EngineAvailability>> => {
      const map = new Map<EngineId, EngineAvailability>();
      for (const id of ids) {
        map.set(id, {
          available: !!available[id],
          command: id,
          displayName: id.charAt(0).toUpperCase() + id.slice(1),
        });
      }
      return map;
    },
  };
}

function loadModule(available: Record<string, boolean>) {
  return proxyquire('../../engine-detection', {
    vscode: require('./mocks/vscode'),
    './adapters/engine': makeStub(available),
  });
}

describe('engine-detection', () => {
  describe('ENGINE_PRIORITY', () => {
    it('should contain exactly 4 built-in engines (no custom)', () => {
      const mod = loadModule({});
      assert.deepEqual(mod.ENGINE_PRIORITY, ['claude', 'codex', 'gemini', 'ollama']);
      assert.ok(!mod.ENGINE_PRIORITY.includes('custom'), 'should not include custom');
    });
  });

  describe('detectEngines()', () => {
    it('should select claude when all engines are available (priority order)', async () => {
      const mod = loadModule({
        claude: true,
        codex: true,
        gemini: true,
        ollama: true,
      });

      const result = await mod.detectEngines();
      assert.equal(result.autoSelected, 'claude');
      assert.deepEqual(result.available, ['claude', 'codex', 'gemini', 'ollama']);
    });

    it('should select gemini when only gemini is available', async () => {
      const mod = loadModule({
        claude: false,
        codex: false,
        gemini: true,
        ollama: false,
      });

      const result = await mod.detectEngines();
      assert.equal(result.autoSelected, 'gemini');
      assert.deepEqual(result.available, ['gemini']);
    });

    it('should select codex when codex and ollama are available', async () => {
      const mod = loadModule({
        claude: false,
        codex: true,
        gemini: false,
        ollama: true,
      });

      const result = await mod.detectEngines();
      assert.equal(result.autoSelected, 'codex');
      assert.deepEqual(result.available, ['codex', 'ollama']);
    });

    it('should return autoSelected: null when no engines are available', async () => {
      const mod = loadModule({
        claude: false,
        codex: false,
        gemini: false,
        ollama: false,
      });

      const result = await mod.detectEngines();
      assert.equal(result.autoSelected, null);
      assert.deepEqual(result.available, []);
    });

    it('should only check 4 built-in engines (no custom)', async () => {
      const checkedIds: EngineId[] = [];
      const mod = proxyquire('../../engine-detection', {
        vscode: require('./mocks/vscode'),
        './adapters/engine': {
          checkEngineAvailability: async (ids: EngineId[]) => {
            checkedIds.push(...ids);
            const map = new Map<EngineId, EngineAvailability>();
            for (const id of ids) {
              map.set(id, { available: false, command: id, displayName: id });
            }
            return map;
          },
        },
      });

      await mod.detectEngines();
      assert.equal(checkedIds.length, 4);
      assert.ok(!checkedIds.includes('custom'), 'should not check custom engine');
    });
  });
});
