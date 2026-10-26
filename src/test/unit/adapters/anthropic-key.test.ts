import { strict as assert } from 'assert';
import { host, setHost, MoagHost } from '../../../core/host';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

/** A fake @anthropic-ai/sdk: records the key it was built with, answers end_turn at once. */
function fakeSdk(keys: string[]): unknown {
  class Anthropic {
    messages = {
      stream: () => ({
        async *[Symbol.asyncIterator]() { /* no events */ },
        finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }),
      }),
    };
    constructor(o: { apiKey: string }) { keys.push(o.apiKey); }
  }
  return { default: Anthropic };
}

describe('Anthropic adapter: where the API key comes from', () => {
  let savedHost: MoagHost;
  let savedEnvKey: string | undefined;
  let warnings: string[];
  let keys: string[];

  beforeEach(() => {
    savedHost = host();
    savedEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    warnings = [];
    keys = [];
  });

  afterEach(() => {
    setHost(savedHost);
    if (savedEnvKey === undefined) { delete process.env.ANTHROPIC_API_KEY; } else { process.env.ANTHROPIC_API_KEY = savedEnvKey; }
    vscodeMock.clearMockConfig();
  });

  /** Install a host whose secret() answers with `secret` (or rejects when it is an Error). */
  function installHost(secret: string | undefined | Error | 'no-method'): void {
    const h: MoagHost = {
      getConfiguration: (section: string) => vscodeMock.workspace.getConfiguration(section),
      warn: (m: string) => { warnings.push(m); },
      workspaceRoot: () => '/mock/workspace',
    };
    if (secret !== 'no-method') {
      h.secret = async () => {
        if (secret instanceof Error) { throw secret; }
        return secret;
      };
    }
    setHost(h);
  }

  function loadAdapter(): { runTask(o: { prompt: string; cwd: string }): Promise<{ exitCode: number; stderr: string }> } {
    const { AnthropicAdapter } = proxyquire('../../../adapters/anthropic-adapter', {
      '@anthropic-ai/sdk': fakeSdk(keys),
    });
    // eslint-disable-next-line no-restricted-syntax -- the unit under test, not an engine lookup
    return new AnthropicAdapter();
  }

  it('the SecretStorage key wins over the environment', async () => {
    installHost('sk-ant-from-secret-storage');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    const r = await loadAdapter().runTask({ prompt: 'hi', cwd: process.cwd() });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(keys, ['sk-ant-from-secret-storage']);
  });

  it('uses ANTHROPIC_API_KEY when there is no stored secret', async () => {
    installHost(undefined);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    await loadAdapter().runTask({ prompt: 'hi', cwd: process.cwd() });
    assert.deepEqual(keys, ['sk-ant-from-env']);
  });

  it('uses ANTHROPIC_API_KEY when the host has no secret store (headless)', async () => {
    installHost('no-method');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    await loadAdapter().runTask({ prompt: 'hi', cwd: process.cwd() });
    assert.deepEqual(keys, ['sk-ant-from-env']);
  });

  it('falls through to the environment when the secret store rejects', async () => {
    installHost(new Error('keychain locked'));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    await loadAdapter().runTask({ prompt: 'hi', cwd: process.cwd() });
    assert.deepEqual(keys, ['sk-ant-from-env']);
  });

  it('uses the legacy setting last, and warns exactly once over two calls', async () => {
    installHost(undefined);
    vscodeMock.setMockConfig('agentTaskPlayer.engines.anthropic', { apiKey: 'sk-ant-legacy-setting' });
    const adapter = loadAdapter();
    await adapter.runTask({ prompt: 'one', cwd: process.cwd() });
    await adapter.runTask({ prompt: 'two', cwd: process.cwd() });
    assert.deepEqual(keys, ['sk-ant-legacy-setting', 'sk-ant-legacy-setting']);
    assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
    assert.ok(!warnings[0].includes('sk-ant-legacy-setting'), 'the warning must not echo the key');
  });

  it('with no key anywhere, fails with exit 1 and names the command and the variable', async () => {
    installHost(undefined);
    const r = await loadAdapter().runTask({ prompt: 'hi', cwd: process.cwd() });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /MOAG: Set Anthropic API Key/);
    assert.match(r.stderr, /ANTHROPIC_API_KEY/);
    assert.deepEqual(keys, [], 'no client is built without a key');
  });
});
