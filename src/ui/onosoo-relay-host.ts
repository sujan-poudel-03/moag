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
import { createReasonedIdentityCache, IdentityAbsenceReason } from '../headless/project-id';
import type { ProjectIdentity, ProjectIdentityResolution } from '../headless/project-identity';
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
  /** The loaded plan's file path. */
  planPath(): string | null;
  /**
   * The loaded plan object. A run whose plan is not this one (a prompt or single-task temp
   * plan) reports planPath '<inline prompt>' rather than the open plan's path.
   */
  loadedPlan?(): Plan | null;
  log(line: string): void;
  /** Resolves one folder's project identity with its reason (tests; default: git). */
  resolveIdentity?: (dir: string) => Promise<ProjectIdentityResolution>;
}

/**
 * A read-only view of the relay host for the ONOSOO project ID command and the dashboard
 * segment: the relay status, the relay's folder, the env a run sees, and the identity cache.
 */
export interface OnosooProjectView {
  status(): RelayStatus;
  /** The relay's folder: the first workspace folder, or null. */
  folder(): string | null;
  firstFolderName(): string | null;
  isMultiRoot(): boolean;
  /** process.env plus the relay variables activate() took out of it. */
  env(): NodeJS.ProcessEnv;
  identities: {
    peek(dir: string): ProjectIdentity | null | undefined;
    reasonOf(dir: string): IdentityAbsenceReason | undefined;
    warm(dir: string, opts?: { priority?: boolean }): Promise<ProjectIdentity | null>;
  };
  /** Fires when the status is drawn (a reprobe, or the controller mid-run) and when a warmed identity lands. */
  onDidChange(listener: () => void): { dispose(): void };
}

/** What activate() keeps: the pairing commands and the PR follow-up use it. */
export interface OnosooRelayHost {
  /** Re-read the pairing and redraw the status bar (after Connect / Disconnect). */
  reprobe(): void;
  /** True while a run is being relayed. */
  isLive(): boolean;
  /** Report a PR opened right after a relayed run on that run in ONOSOO. Never rejects. */
  notePrCreated?(url: string): Promise<void>;
  /** The project view the copy command and the dashboard segment read. */
  readonly project: OnosooProjectView;
}

/** Call once during activate(), after the runner exists. */
export function initOnosooRelayHost(deps: OnosooRelayHostDeps): OnosooRelayHost {
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, ...deps.relayEnv });
  const cwd = (): string | null => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const enabled = (): boolean => vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('onosoo.relay', true);
  const fullAuto = (): boolean => vscode.workspace.getConfiguration('agentTaskPlayer').get<boolean>('fullAuto', false);

  // ─── Status bar ───

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  item.command = { command: 'workbench.action.openSettings', title: 'ONOSOO', arguments: [RELAY_SETTING] };

  let lastStatus: RelayStatus = 'none';
  const listeners = new Set<() => void>();
  /** Tell every project-view listener; one that throws never disturbs the others or a run. */
  const fire = (): void => {
    for (const l of [...listeners]) {
      try { l(); } catch { /* a listener never disturbs the host */ }
    }
  };

  const render = (status: RelayStatus): void => {
    lastStatus = status;
    switch (status) {
      case 'none':
        item.hide();
        fire();
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
    fire();
  };

  // Project identity (protocol v1.2): warmed whenever this machine is paired, so a run rarely
  // waits for it and the dashboard can show it (local git only; nothing is sent while off).
  const reasoned = createReasonedIdentityCache({ resolve: deps.resolveIdentity });
  const identities = reasoned.cache;

  const reprobe = (): void => {
    const s = probeRelayStatus(env(), cwd(), enabled(), deps.log);
    render(s);
    const c = cwd();
    if (s !== 'none' && c) {
      try { void identities.warm(c).then(fire, () => undefined); } catch { /* warming never disturbs the host */ }
    }
  };
  reprobe();

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(RELAY_SETTING)) { reprobe(); }
  });
  // The first folder is the relay's workspace (and the key check runs against it).
  const foldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => reprobe());

  /** The loaded plan's path, or null (→ '<inline prompt>') for a run of some other plan. */
  const planPath = (): string | null => {
    if (deps.loadedPlan && deps.runner.currentPlan !== deps.loadedPlan()) { return null; }
    return deps.planPath();
  };

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
        'ONOSOO shows $0.00 for Claude runs in text mode because Claude reports cost only in JSON output, and MOAG never guesses a cost. Set agentTaskPlayer.engines.claude.outputFormat to "json" to see real cost (live output then appears when each call ends).',
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
    planPath,
    fullAuto,
    log: deps.log,
    onStatus: render,
    onRunRelayed: maybeNotice,
    identity: identities,
  });

  deps.context.subscriptions.push(item, configListener, foldersListener, {
    dispose: () => {
      listeners.clear();
      controller.dispose();
    },
  });

  const project: OnosooProjectView = {
    status: () => lastStatus,
    folder: cwd,
    firstFolderName: () => vscode.workspace.workspaceFolders?.[0]?.name ?? null,
    isMultiRoot: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    env,
    identities: {
      peek: (d) => identities.peek(d),
      reasonOf: (d) => reasoned.reasonOf(d),
      warm: (d, o) => identities.warm(d, o),
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };

  return {
    reprobe,
    isLive: () => controller.live,
    notePrCreated: (url) => controller.notePrCreated(url),
    project,
  };
}
