// ─── Budget notice (VS Code) — the ceiling cannot stop unreported cost ───
//
// costBudgetUsd counts recorded cost only. At the start of every run whose engines
// cannot report cost while a ceiling is set, MOAG says so; and if a call reports no
// cost during a run that was not flagged (an engine that usually reports, failing to),
// it says so then. At most once per run. "Don't show again for this workspace" is
// remembered in workspaceState, so another workspace (or a new one) still hears it.
// With Claude in text mode the notice offers to switch it to JSON output, which makes
// Claude's cost count.

import * as vscode from 'vscode';
import { RunnerState } from '../models/types';
import { BUDGET_UNENFORCEABLE_TEXT, budgetNoticeForRun, UnreportedSource } from '../utils/budget-notice';
import { costLedger } from '../utils/cost-ledger';

/** workspaceState: the user silenced the notice for this workspace. */
export const BUDGET_NOTICE_DISMISSED_KEY = 'agentTaskPlayer.budgetUnenforceableNoticeDismissed';

export const USE_JSON_OUTPUT = 'Use JSON output (enforce budget)';
export const OPEN_SETTING = 'Open Setting';
export const DONT_SHOW_FOR_WORKSPACE = "Don't show again for this workspace";

const CLAUDE_SECTION = 'agentTaskPlayer.engines.claude';

/** The runner slice this listens to. */
export interface BudgetNoticeRunner {
  on(event: 'state-changed', listener: (state: RunnerState) => void): void;
  off?(event: 'state-changed', listener: (state: RunnerState) => void): void;
  readonly state: RunnerState;
}

export interface BudgetNoticeDeps {
  workspaceState: Pick<vscode.Memento, 'get' | 'update'>;
  runner: BudgetNoticeRunner;
  /** The engines the run that is starting will call. */
  engineIdsForRun(): string[];
  ledger?: UnreportedSource;
}

/** Wire the notice; returns the dispose function. */
export function initBudgetNotice(d: BudgetNoticeDeps): () => void {
  let shownThisRun = false;
  let lastState: RunnerState = d.runner.state;

  const budget = (): number => vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('costBudgetUsd', 10);
  const dismissed = (): boolean => d.workspaceState.get<boolean>(BUDGET_NOTICE_DISMISSED_KEY, false) === true;

  const show = (text: string, offerJson: boolean): void => {
    shownThisRun = true;
    const first = offerJson ? USE_JSON_OUTPUT : OPEN_SETTING;
    void vscode.window.showWarningMessage(text, first, DONT_SHOW_FOR_WORKSPACE).then(async (choice) => {
      try {
        if (choice === USE_JSON_OUTPUT) {
          await vscode.workspace.getConfiguration(CLAUDE_SECTION).update('outputFormat', 'json', vscode.ConfigurationTarget.Workspace);
          void vscode.window.showInformationMessage('Claude now uses JSON output in this workspace, so its cost counts against the ceiling.');
        } else if (choice === OPEN_SETTING) {
          await vscode.commands.executeCommand('workbench.action.openSettings', `${CLAUDE_SECTION}.outputFormat`);
        } else if (choice === DONT_SHOW_FOR_WORKSPACE) {
          await d.workspaceState.update(BUDGET_NOTICE_DISMISSED_KEY, true);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not apply that: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, () => undefined);
  };

  const onState = (state: RunnerState): void => {
    const prev = lastState;
    lastState = state;
    if (state !== RunnerState.Playing || prev !== RunnerState.Idle) { return; }
    shownThisRun = false;
    try {
      if (dismissed()) { return; }
      const notice = budgetNoticeForRun({
        budget: budget(),
        engines: d.engineIdsForRun(),
        claudeOutputFormat: vscode.workspace.getConfiguration(CLAUDE_SECTION).get<string>('outputFormat', 'text'),
      });
      if (notice) { show(notice.text, notice.offerJson); }
    } catch { /* a notice never disturbs a run */ }
  };
  d.runner.on('state-changed', onState);

  // A call that reported no cost in a run that was not flagged at its start.
  const offUnreported = (d.ledger ?? costLedger).onUnreported(() => {
    try {
      if (shownThisRun || dismissed() || !(budget() > 0)) { return; }
      show(BUDGET_UNENFORCEABLE_TEXT, false);
    } catch { /* never disturbs accounting */ }
  });

  return () => {
    offUnreported();
    try { d.runner.off?.('state-changed', onState); } catch { /* ignore */ }
  };
}
