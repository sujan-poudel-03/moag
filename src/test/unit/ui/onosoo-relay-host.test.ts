// ─── onosoo-relay-host: setting, status bar and the one-time cost notice ───

import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { REVOKED_MESSAGE } from '../../../headless/onosoo-relay';
import type { HostRunRelayDeps, RelayStatus } from '../../../headless/host-run-relay';
import type { Plan } from '../../../models/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

type HostModule = typeof import('../../../ui/onosoo-relay-host');

interface FakeItem {
  text: string;
  tooltip: string;
  command: unknown;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

const plan = (engines: Array<string | undefined>, defaultEngine = 'codex'): Plan => ({
  version: '1.0',
  name: 'P',
  defaultEngine,
  playlists: [{ id: 'pl', name: 'Build', tasks: engines.map((engine, i) => ({ id: `t${i}`, name: `T${i}`, prompt: 'x', engine })) }],
} as unknown as Plan);

describe('onosoo-relay-host', () => {
  let item: FakeItem;
  let captured: HostRunRelayDeps | null;
  let controllerDispose: sinon.SinonSpy;
  let probe: sinon.SinonStub;
  let configListener: ((e: { affectsConfiguration(s: string): boolean }) => void) | null;
  let globalStore: Map<string, unknown>;
  let update: sinon.SinonStub;
  let subscriptions: Array<{ dispose(): unknown }>;

  beforeEach(() => {
    item = {
      text: '', tooltip: '', command: undefined, visible: false,
      show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { /* noop */ },
    };
    captured = null;
    controllerDispose = sinon.spy();
    probe = sinon.stub().returns('none');
    configListener = null;
    globalStore = new Map();
    update = sinon.stub().callsFake(async (k: string, v: unknown) => { globalStore.set(k, v); });
    subscriptions = [];
    sinon.stub(vscodeMock.window, 'createStatusBarItem').returns(item);
    sinon.stub(vscodeMock.workspace, 'onDidChangeConfiguration').callsFake((...args: unknown[]) => {
      configListener = args[0] as typeof configListener;
      return { dispose: () => undefined };
    });
  });

  afterEach(() => {
    sinon.restore();
    vscodeMock.clearMockConfig();
  });

  /** A fresh copy of the module (so its once-per-session flag starts unset), initialised. */
  function init(relayEnv: Record<string, string> = {}): HostModule {
    const mod = proxyquire('../../../ui/onosoo-relay-host', {
      vscode: vscodeMock,
      '../headless/host-run-relay': {
        createHostRunRelay: (d: HostRunRelayDeps) => {
          captured = d;
          return { dispose: controllerDispose, status: 'none', live: false };
        },
        probeRelayStatus: probe,
      },
    }) as HostModule;
    mod.initOnosooRelayHost({
      context: {
        globalState: { get: <T>(k: string, d: T): T => (globalStore.has(k) ? globalStore.get(k) as T : d), update, keys: () => [], setKeysForSync: () => undefined },
        subscriptions,
      } as unknown as Parameters<HostModule['initOnosooRelayHost']>[0]['context'],
      runner: {} as never,
      relayEnv,
      planPath: () => null,
      log: () => undefined,
    });
    return mod;
  }

  // ─── status bar ───

  it('renders every status, and hides for none', () => {
    init();
    assert.equal(item.visible, false, 'the initial probe said none');
    assert.deepEqual(item.command, { command: 'workbench.action.openSettings', title: 'ONOSOO', arguments: ['agentTaskPlayer.onosoo.relay'] });
    const render = (s: RelayStatus): void => captured!.onStatus!(s);
    render('on');
    assert.deepEqual([item.text, item.tooltip, item.visible], ['$(cloud) ONOSOO', 'ONOSOO: connected — runs started here appear in ONOSOO Builds', true]);
    render('off');
    assert.deepEqual([item.text, item.tooltip, item.visible], ['$(circle-slash) ONOSOO: off', 'Relaying is off (agentTaskPlayer.onosoo.relay)', true]);
    render('revoked');
    assert.deepEqual([item.text, item.tooltip, item.visible], ['$(warning) ONOSOO: key revoked', REVOKED_MESSAGE, true]);
    render('none');
    assert.equal(item.visible, false);
  });

  it('the initial render uses the probe, and a relay-setting change probes again', () => {
    probe.returns('on');
    init();
    assert.equal(item.visible, true);
    assert.equal(probe.callCount, 1);
    configListener!({ affectsConfiguration: (s) => s === 'agentTaskPlayer.fullAuto' });
    assert.equal(probe.callCount, 1, 'an unrelated setting does not re-probe');
    probe.returns('off');
    vscodeMock.setMockConfig('agentTaskPlayer', { 'onosoo.relay': false });
    configListener!({ affectsConfiguration: (s) => s === 'agentTaskPlayer.onosoo.relay' });
    assert.equal(probe.callCount, 2);
    assert.equal(probe.lastCall.args[2], false, 'the probe sees the new setting');
    assert.equal(item.text, '$(circle-slash) ONOSOO: off');
  });

  // ─── readers ───

  it('enabled() honours the setting, default true', () => {
    init();
    assert.equal(captured!.enabled(), true);
    vscodeMock.setMockConfig('agentTaskPlayer', { 'onosoo.relay': false });
    assert.equal(captured!.enabled(), false);
  });

  it('env() carries the snapshot key while process.env does not', () => {
    const before = process.env.MOAG_ONOSOO_KEY;
    delete process.env.MOAG_ONOSOO_KEY;
    try {
      init({ MOAG_ONOSOO_KEY: 'snap-key-1234' });
      assert.equal(captured!.env().MOAG_ONOSOO_KEY, 'snap-key-1234');
      assert.equal(process.env.MOAG_ONOSOO_KEY, undefined);
    } finally {
      if (before !== undefined) { process.env.MOAG_ONOSOO_KEY = before; }
    }
  });

  it('cwd() is the first workspace folder', () => {
    init();
    assert.equal(captured!.cwd(), '/mock/workspace');
  });

  // ─── planUsesClaude ───

  it('planUsesClaude: task, playlist and plan engines in that order', () => {
    const { planUsesClaude } = init();
    assert.equal(planUsesClaude(plan(['codex'], 'claude')), false);
    assert.equal(planUsesClaude(plan([undefined], 'claude')), true);
    assert.equal(planUsesClaude(plan(['codex', 'claude'])), true);
    const p = plan([undefined]);
    (p.playlists[0] as { engine?: string }).engine = 'claude';
    assert.equal(planUsesClaude(p), true);
  });

  // ─── cost notice ───

  it('the notice shows once per session for a Claude plan in text mode', () => {
    const show = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    init();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    assert.equal(show.callCount, 1);
    assert.ok(String(show.firstCall.args[0]).startsWith('ONOSOO will show $0.00 for Claude runs'));
    assert.deepEqual(show.firstCall.args.slice(1), ['Open Setting', "Don't Show Again"]);
  });

  it('no notice in json mode', () => {
    const show = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    vscodeMock.setMockConfig('agentTaskPlayer.engines.claude', { outputFormat: 'json' });
    init();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    assert.equal(show.callCount, 0);
  });

  it('no notice for a Codex-only plan', () => {
    const show = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    init();
    captured!.onRunRelayed!(plan(['codex', undefined], 'codex'));
    assert.equal(show.callCount, 0);
  });

  it('no notice once dismissed for good', () => {
    const show = sinon.stub(vscodeMock.window, 'showInformationMessage').resolves(undefined);
    globalStore.set('agentTaskPlayer.onosoo.textCostNoticeDismissed', true);
    init();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    assert.equal(show.callCount, 0);
  });

  it("Don't Show Again writes the globalState key", async () => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').resolves("Don't Show Again");
    const { TEXT_COST_NOTICE_KEY } = init();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    await new Promise((r) => setImmediate(r));
    assert.ok(update.calledOnceWith(TEXT_COST_NOTICE_KEY, true));
  });

  it('Open Setting opens the Claude output-format setting', async () => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').resolves('Open Setting');
    const exec = sinon.stub(vscodeMock.commands, 'executeCommand').resolves(undefined);
    init();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    await new Promise((r) => setImmediate(r));
    assert.ok(exec.calledOnceWith('workbench.action.openSettings', 'agentTaskPlayer.engines.claude.outputFormat'));
  });

  it('a never-resolving notice does not block the run', () => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').returns(new Promise(() => undefined));
    init();
    const t0 = Date.now();
    captured!.onRunRelayed!(plan([undefined], 'claude'));
    assert.ok(Date.now() - t0 < 100);
  });

  it('a throwing globalState.update does not throw out', async () => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').resolves("Don't Show Again");
    update.callsFake(() => { throw new Error('storage gone'); });
    init();
    assert.doesNotThrow(() => captured!.onRunRelayed!(plan([undefined], 'claude')));
    await new Promise((r) => setImmediate(r));
    assert.equal(update.callCount, 1);
  });

  it('a throwing showInformationMessage does not throw out', () => {
    sinon.stub(vscodeMock.window, 'showInformationMessage').throws(new Error('no window'));
    init();
    assert.doesNotThrow(() => captured!.onRunRelayed!(plan([undefined], 'claude')));
  });

  // ─── lifecycle ───

  it('disposing the subscriptions disposes the controller', () => {
    init();
    assert.equal(subscriptions.length, 3);
    for (const s of subscriptions) { s.dispose(); }
    assert.equal(controllerDispose.callCount, 1);
  });
});
