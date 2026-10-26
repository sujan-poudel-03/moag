import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const KEY = 'onosoo-device-key-CCCC3333';

interface Msg { kind: 'info' | 'warn' | 'error'; text: string; modal: boolean }

function load(o: { input?: string; answer?: string }) {
  const messages: Msg[] = [];
  const executed: Array<{ id: string; arg: unknown }> = [];
  const vscode = {
    ...vscodeMock,
    window: {
      ...vscodeMock.window,
      showInputBox: async () => o.input,
      showInformationMessage: async (text: string) => { messages.push({ kind: 'info', text, modal: false }); return undefined; },
      showErrorMessage: async (text: string) => { messages.push({ kind: 'error', text, modal: false }); return undefined; },
      showWarningMessage: async (text: string, ...rest: unknown[]) => {
        const modal = typeof rest[0] === 'object' && rest[0] !== null && (rest[0] as { modal?: boolean }).modal === true;
        messages.push({ kind: 'warn', text, modal });
        return o.answer;
      },
    },
    commands: { ...vscodeMock.commands, executeCommand: async (id: string, arg: unknown) => { executed.push({ id, arg }); } },
  };
  const mod = proxyquire('../../../ui/onosoo-pairing', { vscode });
  return { mod, messages, executed };
}

describe('ONOSOO pairing commands', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let reprobes: number;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'onosoo-pairing-'));
    env = { APPDATA: home, XDG_CONFIG_HOME: home };
    reprobes = 0;
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const deps = (over: Record<string, unknown> = {}) => ({
    relayEnv: {},
    reprobe: () => { reprobes++; },
    isLive: () => false,
    location: { env, platform: 'linux' as NodeJS.Platform, homedir: () => home },
    ...over,
  });

  it('Connect, refused (401): a warning with Try Again, the key in no message, and the status bar re-probed', async () => {
    const { mod, messages } = load({ input: KEY, answer: undefined });
    await mod.cmdConnectOnosoo(deps({ http: async () => ({ status: 401, body: '' }) }));
    const warn = messages.find((m) => m.kind === 'warn');
    assert.ok(warn, JSON.stringify(messages));
    assert.match(warn.text, /refused the key/);
    for (const m of messages) { assert.ok(!m.text.includes(KEY), m.text); }
    assert.equal(reprobes, 1);
  });

  it('Connect, refused, Try Again runs the command again', async () => {
    const { mod, executed } = load({ input: KEY, answer: 'Try Again' });
    await mod.cmdConnectOnosoo(deps({ http: async () => ({ status: 403, body: '' }) }), { url: 'https://x.example.com' });
    assert.deepEqual(executed, [{ id: 'agentTaskPlayer.connectOnosoo', arg: { url: 'https://x.example.com' } }]);
  });

  it('Connect, accepted: "Connected to ONOSOO Builds." and the key is saved', async () => {
    const { mod, messages } = load({ input: KEY });
    await mod.cmdConnectOnosoo(deps({ http: async () => ({ status: 200, body: '{}' }) }));
    assert.ok(messages.some((m) => m.kind === 'info' && m.text === 'Connected to ONOSOO Builds.'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'moag', 'onosoo.json'), 'utf-8')).key, KEY);
  });

  it('Connect with an env key warns that it overrides the saved one', async () => {
    const { mod, messages } = load({ input: KEY });
    await mod.cmdConnectOnosoo(deps({ relayEnv: { MOAG_ONOSOO_KEY: 'other-env-key-1234' }, http: async () => ({ status: 200, body: '{}' }) }));
    assert.ok(messages.some((m) => m.kind === 'warn' && /overrides the saved key/.test(m.text)));
  });

  it('Connect cancelled at the input box writes nothing', async () => {
    const { mod } = load({ input: undefined });
    await mod.cmdConnectOnosoo(deps({ http: async () => ({ status: 200, body: '' }) }));
    assert.equal(fs.existsSync(path.join(home, 'moag', 'onosoo.json')), false);
    assert.equal(reprobes, 0);
  });

  it('Connect with a changed key and unsent events asks first; declining keeps everything', async () => {
    fs.mkdirSync(path.join(home, 'moag', 'onosoo-spool', 'ws'), { recursive: true });
    fs.writeFileSync(path.join(home, 'moag', 'onosoo.json'), JSON.stringify({ key: 'old-device-key-0000', url: 'https://x.example.com' }));
    fs.writeFileSync(path.join(home, 'moag', 'onosoo-spool', 'ws', 'r.jsonl'), '{"meta":{}}\n{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    const { mod, messages } = load({ input: KEY, answer: undefined });
    await mod.cmdConnectOnosoo(deps({ http: async () => ({ status: 200, body: '' }) }));
    const modal = messages.find((m) => m.modal);
    assert.ok(modal);
    assert.match(modal.text, /^3 unsent run events from the previous pairing will be discarded\./);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'moag', 'onosoo.json'), 'utf-8')).key, 'old-device-key-0000');
  });

  it('Connect while a run is relayed asks first; declining writes nothing', async () => {
    const { mod, messages } = load({ input: KEY, answer: undefined });
    await mod.cmdConnectOnosoo(deps({ isLive: () => true, http: async () => ({ status: 200, body: '' }) }));
    const modal = messages.find((m) => m.modal);
    assert.ok(modal);
    assert.match(modal.text, /A run is being relayed to ONOSOO\. Change the device key now\?/);
    assert.equal(fs.existsSync(path.join(home, 'moag', 'onosoo.json')), false);
  });

  it('Connect while a run is relayed, confirmed: saves the key', async () => {
    const { mod } = load({ input: KEY, answer: 'Change Key' });
    await mod.cmdConnectOnosoo(deps({ isLive: () => true, http: async () => ({ status: 200, body: '' }) }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'moag', 'onosoo.json'), 'utf-8')).key, KEY);
  });

  it('Disconnect refuses while a run is relayed', async () => {
    fs.mkdirSync(path.join(home, 'moag'), { recursive: true });
    fs.writeFileSync(path.join(home, 'moag', 'onosoo.json'), JSON.stringify({ key: KEY, device_id: 'd1' }));
    const { mod, messages } = load({ answer: 'Disconnect' });
    await mod.cmdDisconnectOnosoo(deps({ isLive: () => true }));
    assert.match(messages[0].text, /A run is being relayed; disconnect after it ends\./);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'moag', 'onosoo.json'), 'utf-8')).key, KEY);
  });

  it('Disconnect after the modal removes the key and keeps the device id', async () => {
    fs.mkdirSync(path.join(home, 'moag'), { recursive: true });
    fs.writeFileSync(path.join(home, 'moag', 'onosoo.json'), JSON.stringify({ key: KEY, url: 'https://x.example.com', device_id: 'd1' }));
    const { mod } = load({ answer: 'Disconnect' });
    await mod.cmdDisconnectOnosoo(deps());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'moag', 'onosoo.json'), 'utf-8')), { device_id: 'd1' });
    assert.equal(reprobes, 1);
  });
});
