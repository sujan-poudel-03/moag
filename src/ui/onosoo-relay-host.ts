// ─── ONOSOO relay host — runs started in VS Code, relayed to ONOSOO Builds ───
//
// The VS Code side of src/headless/host-run-relay.ts: the agentTaskPlayer.onosoo.relay
// setting, the status-bar item, and the one-time "cost shows $0.00" notice. The
// controller itself is vscode-free and is driven by the runner's own events, so no play
// command has to know about it.

import * as vscode from 'vscode';
import { createHostRunRelay, HostRelayRunner, probeRelayStatus, RelayStatus } from '../headless/host-run-relay';
import type { RelayEnvSnapshot } from '../headless/run-reporter';
import { REVOKED_MESSAGE } from '../headless/onosoo-relay';
import type { Plan } from '../models/types';

/** globalState key: the user dismissed the text-mode cost notice for good. */
export const TEXT_COST_NOTICE_KEY = 'agentTaskPlayer.onosoo.textCostNoticeDismissed';

const RELAY_SETTING = 'agentTaskPlayer.onosoo.relay';
const CLAUDE_FORMAT_SETTING = 'agentTaskPlayer.engines.claude.outputFormat';

/** The notice shows at most once per extension-host session. */
let shownThisSession = false;

/** True when some task of `plan` runs on Claude (task → playlist → plan default). */
export function planUsesClaude(plan: Plan): boolean {
  return plan.playlists.some((pl) => pl.tasks.some((t) => (t.engine || pl.engine || plan.defaultEngine) === 'claude'));
}

/** What the host needs from activate(). */
export interface OnosooRelayHostDeps {
  context: Pick<vscode.ExtensionContext, 'globalState' | 'subscriptions'>;
  runner: HostRelayRunner;
  /** The relay variables activate() took out of process.env. */
  relayEnv: RelayEnvSnapshot;
  planPath(): string | null;
  log(line: string): void;
}

/** Call once during activate(), after the runner exists. */
export function initOnosooRelayHost(deps: OnosooRelayHostDeps): void {
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, ...deps.relayEnv });
  const cwd = (): string | null => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const enabled = (): boolean => vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('onosoo.relay', true);
  const fullAuto = (): boolean => vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('fullAuto', false);

  // ─── Status bar ───

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = { command: 'workbench.action.openSettings', title: 'ONOSOO', arguments: [RELAY_SETTING] };

  const render = (status: RelayStatus): void => {
    switch (status) {
      case 'none':
        item.hide();
        return;
      case 'on':
        item.text = '$(cloud) ONOSOO';
        item.tooltip = 'ONOSOO: connected — runs started here appear in ONOSOO Builds';
        break;
      case 'off':
        item.text = '$(circle-slash) ONOSOO: off';
        item.tooltip = `Relaying is off (${RELAY_SETTING})`;
        break;
      case 'revoked':
        item.text = '$(warning) ONOSOO: key revoked';
        item.tooltip = REVOKED_MESSAGE;
        break;
    }
    item.show();
  };

  render(probeRelayStatus(env(), cwd(), enabled(), deps.log));

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(RELAY_SETTING)) {
      render(probeRelayStatus(env(), cwd(), enabled(), deps.log));
    }
  });

  // ─── Cost notice ───

  /** Claude reports cost only in JSON output: say so once, when a relayed plan uses Claude in text mode. */
  const maybeNotice = (plan: Plan): void => {
    try {
      if (shownThisSession) { return; }
      if (deps.context.globalState.get<boolean>(TEXT_COST_NOTICE_KEY, false)) { return; }
      if (vscode.workspace.getConfiguration('agentTaskPlayer.engines.claude').get<string>('outputFormat', 'text') !== 'text') { return; }
      if (!planUsesClaude(plan)) { return; }
      shownThisSession = true;
      void vscode.window.showInformationMessage(
        'ONOSOO will show $0.00 for Claude runs: Claude reports its cost only in JSON output. Set agentTaskPlayer.engines.claude.outputFormat to "json" to see real cost (live output then appears when each call ends).',
        'Open Setting',
        "Don't Show Again",
      ).then((choice) => {
        try {
          if (choice === 'Open Setting') {
            void vscode.commands.executeCommand('workbench.action.openSettings', CLAUDE_FORMAT_SETTING);
          } else if (choice === "Don't Show Again") {
            void Promise.resolve(deps.context.globalState.update(TEXT_COST_NOTICE_KEY, true)).catch(() => undefined);
          }
        } catch { /* a notice never disturbs a run */ }
      }, () => undefined);
    } catch { /* a notice never disturbs a run */ }
  };

  // ─── Controller ───

  const controller = createHostRunRelay({
    runner: deps.runner,
    cwd,
    env,
    enabled,
    planPath: deps.planPath,
    fullAuto,
    log: deps.log,
    onStatus: render,
    onRunRelayed: maybeNotice,
  });

  deps.context.subscriptions.push(item, configListener, { dispose: () => controller.dispose() });
}
