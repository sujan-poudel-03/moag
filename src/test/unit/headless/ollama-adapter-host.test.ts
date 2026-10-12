import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

/**
 * Proves the ollama adapter picks up `agentTaskPlayer.engines.ollama.host` when
 * running headless (CLI/daemon), not just inside the VS Code extension host.
 *
 * installVscodeShim() must NOT be called here: it hooks Module._load globally
 * and never uninstalls, so every later require('vscode') in the process would
 * resolve to the headless shim instead of the test mock — which silently broke
 * 65 runner tests downstream (see config-shapes.test.ts). Instead this test
 * requires the shim module directly and wires it into the adapter via
 * proxyquire, so the swap is scoped to this file only.
 */
describe('headless — ollama adapter picks up engines.ollama.host', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes OLLAMA_HOST through when .moag/config.json sets engines.ollama.host', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-ollama-host-'));
    fs.mkdirSync(path.join(tmpDir, '.moag'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.moag', 'config.json'),
      JSON.stringify({ 'agentTaskPlayer.engines.ollama.host': '192.168.1.50:11434' }),
      'utf-8',
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shim = require('../../../headless/vscode-shim');
    shim.__setWorkspaceRoot(tmpDir);

    let captured: { env?: Record<string, string> } | undefined;
    const { OllamaAdapter } = proxyquire('../../../adapters/ollama-adapter', {
      '../core/host': {
        getConfig: (section: string) => shim.workspace.getConfiguration(section),
      },
      './base-cli': {
        runCli: (config: { env?: Record<string, string> }) => {
          captured = config;
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
        },
      },
    });

    const adapter = new OllamaAdapter();
    await adapter.runTask({ prompt: 'hi', cwd: tmpDir });

    assert.deepEqual(captured!.env, { OLLAMA_HOST: '192.168.1.50:11434' });
  });

  it('omits env entirely when .moag/config.json has no engines.ollama.host', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-ollama-host-'));
    fs.mkdirSync(path.join(tmpDir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.moag', 'config.json'), JSON.stringify({}), 'utf-8');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shim = require('../../../headless/vscode-shim');
    shim.__setWorkspaceRoot(tmpDir);

    let captured: { env?: Record<string, string> } | undefined;
    const { OllamaAdapter } = proxyquire('../../../adapters/ollama-adapter', {
      '../core/host': {
        getConfig: (section: string) => shim.workspace.getConfiguration(section),
      },
      './base-cli': {
        runCli: (config: { env?: Record<string, string> }) => {
          captured = config;
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
        },
      },
    });

    const adapter = new OllamaAdapter();
    await adapter.runTask({ prompt: 'hi', cwd: tmpDir });

    assert.equal(captured!.env, undefined);
  });
});
