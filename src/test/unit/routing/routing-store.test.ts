import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspaceRoutingConfig,
  validateRoutingConfig,
  saveWorkspaceRoutingConfig,
  RoutingRuleConfig,
} from '../../../routing/routing-store';

describe('routing-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-routing-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when the file is missing', () => {
    assert.deepEqual(loadWorkspaceRoutingConfig(dir), {});
  });

  it('returns {} and does not throw on malformed JSON on disk', () => {
    fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moag', 'routing.json'), '{ not valid json', 'utf8');
    assert.doesNotThrow(() => loadWorkspaceRoutingConfig(dir));
    assert.deepEqual(loadWorkspaceRoutingConfig(dir), {});
  });

  it('round-trips a save then load', () => {
    const config: RoutingRuleConfig = {
      enabled: true,
      simpleEngine: 'ollama',
      complexEngine: 'claude',
      complexityThreshold: 42,
    };
    saveWorkspaceRoutingConfig(dir, config);
    assert.deepEqual(loadWorkspaceRoutingConfig(dir), config);
  });

  it('returns {} and does not throw when the file contains valid JSON `null`', () => {
    fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moag', 'routing.json'), 'null', 'utf8');
    assert.doesNotThrow(() => loadWorkspaceRoutingConfig(dir));
    assert.deepEqual(loadWorkspaceRoutingConfig(dir), {});
  });

  it('returns {} and does not throw when the file contains a JSON array', () => {
    fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moag', 'routing.json'), '[1,2,3]', 'utf8');
    assert.doesNotThrow(() => loadWorkspaceRoutingConfig(dir));
  });

  describe('validateRoutingConfig', () => {
    it('drops an engine outside ENGINE_IDS and lists it in dropped', () => {
      const r = validateRoutingConfig({ simpleEngine: 'ollama', complexEngine: 'rm' });
      assert.deepEqual(r.config, { simpleEngine: 'ollama' });
      assert.equal(r.dropped.length, 1);
      assert.match(r.dropped[0], /complexEngine/);
      assert.match(r.dropped[0], /"rm"/);
    });

    it('keeps every valid field', () => {
      const raw = { enabled: false, simpleEngine: 'gemini', complexEngine: 'claude', complexityThreshold: 0.5 };
      assert.deepEqual(validateRoutingConfig(raw), { config: raw, dropped: [] });
    });

    it('drops a non-boolean enabled and a non-finite / non-number threshold', () => {
      const r = validateRoutingConfig({ enabled: 'yes', complexityThreshold: '5' });
      assert.deepEqual(r.config, {});
      assert.equal(r.dropped.length, 2);
      // JSON cannot carry Infinity, but an in-memory caller can.
      assert.deepEqual(validateRoutingConfig({ complexityThreshold: Infinity }).config, {});
      assert.deepEqual(validateRoutingConfig({ complexityThreshold: NaN }).config, {});
    });

    it('drops a non-string engine (object, number) without throwing', () => {
      const r = validateRoutingConfig({ simpleEngine: { toString: 'claude' }, complexEngine: 7 });
      assert.deepEqual(r.config, {});
      assert.equal(r.dropped.length, 2);
    });

    it('yields {} for an array, null, or scalar payload', () => {
      assert.deepEqual(validateRoutingConfig([1, 2]), { config: {}, dropped: [] });
      assert.deepEqual(validateRoutingConfig(null), { config: {}, dropped: [] });
      assert.deepEqual(validateRoutingConfig('claude'), { config: {}, dropped: [] });
    });

    it('ignores unknown keys (never copies them through)', () => {
      assert.deepEqual(validateRoutingConfig({ enabled: true, command: 'rm -rf /' }).config, { enabled: true });
    });

    it('is applied by loadWorkspaceRoutingConfig to the file on disk', () => {
      fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.moag', 'routing.json'),
        JSON.stringify({ enabled: true, simpleEngine: 'ollama', complexEngine: 'rm' }),
        'utf8',
      );
      assert.deepEqual(loadWorkspaceRoutingConfig(dir), { enabled: true, simpleEngine: 'ollama' });
    });
  });

  it('creates .moag/ if it does not yet exist', () => {
    assert.equal(fs.existsSync(path.join(dir, '.moag')), false);
    saveWorkspaceRoutingConfig(dir, { enabled: true });
    assert.equal(fs.existsSync(path.join(dir, '.moag')), true);
    assert.equal(fs.existsSync(path.join(dir, '.moag', 'routing.json')), true);
  });
});
