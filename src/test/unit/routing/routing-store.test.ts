import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadWorkspaceRoutingConfig,
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

  it('creates .moag/ if it does not yet exist', () => {
    assert.equal(fs.existsSync(path.join(dir, '.moag')), false);
    saveWorkspaceRoutingConfig(dir, { enabled: true });
    assert.equal(fs.existsSync(path.join(dir, '.moag')), true);
    assert.equal(fs.existsSync(path.join(dir, '.moag', 'routing.json')), true);
  });
});
