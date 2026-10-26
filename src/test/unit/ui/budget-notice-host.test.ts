import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import { budgetNoticeForRun, enginesWithoutCost } from '../../../utils/budget-notice';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

describe('budget notice: which runs the ceiling cannot see', () => {
  it('lists the engines that report no cost; Claude counts only in JSON mode', () => {
    assert.deepEqual(enginesWithoutCost(['claude', 'codex', 'anthropic', 'ollama', 'codex', 'copilot'], 'text'), ['claude', 'codex', 'copilot']);
    assert.deepEqual(enginesWithoutCost(['claude', 'anthropic'], 'json'), []);
  });

  it('no notice without a ceiling, or when every engine reports cost', () => {
    assert.equal(budgetNoticeForRun({ budget: 0, engines: ['codex'], claudeOutputFormat: 'text' }), null);
    assert.equal(budgetNoticeForRun({ budget: 10, engines: ['anthropic', 'ollama'], claudeOutputFormat: 'text' }), null);
    assert.equal(budgetNoticeForRun({ budget: 10, engines: ['claude'], claudeOutputFormat: 'json' }), null);
  });

  it('Claude in text mode is offered JSON output; Codex alone is not', () => {
    const c = budgetNoticeForRun({ budget: 10, engines: ['claude', 'codex'], claudeOutputFormat: 'text' })!;
    assert.equal(c.offerJson, true);
    assert.match(c.text, /^The cost ceiling \(\$10\) cannot stop this run: claude and codex report no cost/);
    const x = budgetNoticeForRun({ budget: 5, engines: ['codex'], claudeOutputFormat: 'text' })!;
    assert.equal(x.offerJson, false);
    assert.match(x.text, /codex reports no cost/);
  });
});

describe('budget notice (VS Code host)', () => {
  type Shown = { text: string; buttons: string[] };
  let shown: Shown[];
  let answer: string | undefined;
  let state: Map<string, unknown>;
  let updates: Array<{ section: string; key: string; value: unknown; target: unknown }>;
  let config: Record<string, unknown>;
  let unreported: Array<() => void>;

  function setup(engines: string[]) {
    shown = [];
    state = new Map();
    updates = [];
    unreported = [];
    const vscode = {
      ...vscodeMock,
      window: {
        ...vscodeMock.window,
        showWarningMessage: (text: string, ...buttons: string[]) => { shown.push({ text, buttons }); return Promise.resolve(answer); },
        showInformationMessage: () => Promise.resolve(undefined),
      },
      workspace: {
        ...vscodeMock.workspace,
        getConfiguration: (section: string) => ({
          get: <T>(key: string, d: T): T => (config[`${section}.${key}`] as T) ?? d,
          update: async (key: string, value: unknown, target: unknown) => { updates.push({ section, key, value, target }); },
        }),
      },
    };
    const mod = proxyquire('../../../ui/budget-notice-host', { vscode });
    const runner = new EventEmitter() as EventEmitter & { state: string };
    runner.state = 'idle';
    const ledger = { onUnreported: (l: () => void) => { unreported.push(l); return () => { unreported = unreported.filter((x) => x !== l); }; } };
    const dispose = mod.initBudgetNotice({
      workspaceState: { get: <T>(k: string, d: T): T => (state.has(k) ? state.get(k) as T : d), update: async (k: string, v: unknown) => { state.set(k, v); } },
      runner,
      engineIdsForRun: () => engines,
      ledger,
    });
    const run = (): void => {
      runner.state = 'playing'; runner.emit('state-changed', 'playing');
      runner.state = 'idle'; runner.emit('state-changed', 'idle');
    };
    return { mod, runner, run, dispose };
  }

  beforeEach(() => { answer = undefined; config = { 'agentTaskPlayer.costBudgetUsd': 10 }; });

  it('shows at the start of every run whose engines report no cost, not just once per process', () => {
    const { run } = setup(['codex']);
    run();
    run();
    assert.equal(shown.length, 2);
    assert.deepEqual(shown[0].buttons, ['Open Setting', "Don't show again for this workspace"]);
  });

  it('"Don\'t show again for this workspace" silences it in this workspace only (workspaceState)', async () => {
    answer = "Don't show again for this workspace";
    const { run } = setup(['codex']);
    run();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.get('agentTaskPlayer.budgetUnenforceableNoticeDismissed'), true);
    run();
    assert.equal(shown.length, 1);
  });

  it('Claude in text mode: "Use JSON output (enforce budget)" sets outputFormat to json for the workspace', async () => {
    answer = 'Use JSON output (enforce budget)';
    const { run } = setup(['claude']);
    run();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(shown[0].buttons, ['Use JSON output (enforce budget)', "Don't show again for this workspace"]);
    assert.deepEqual(updates, [{ section: 'agentTaskPlayer.engines.claude', key: 'outputFormat', value: 'json', target: vscodeMock.ConfigurationTarget.Workspace }]);
  });

  it('no notice without a ceiling, or when every engine reports cost', () => {
    config = { 'agentTaskPlayer.costBudgetUsd': 0 };
    setup(['codex']).run();
    config = { 'agentTaskPlayer.costBudgetUsd': 10, 'agentTaskPlayer.engines.claude.outputFormat': 'json' };
    setup(['claude', 'anthropic']).run();
    assert.equal(shown.length, 0);
  });

  it('an unreported call in a run that was not flagged shows it once for that run', () => {
    const { runner } = setup(['anthropic']);
    runner.state = 'playing'; runner.emit('state-changed', 'playing');
    for (const l of unreported) { l(); }
    for (const l of unreported) { l(); }
    assert.equal(shown.length, 1);
  });

  it('dispose removes the listeners', () => {
    const { dispose, runner } = setup(['codex']);
    dispose();
    assert.equal(unreported.length, 0);
    assert.equal(runner.listenerCount('state-changed'), 0);
  });
});
