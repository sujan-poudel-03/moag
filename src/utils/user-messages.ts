// ─── Centralized user-facing messages ───
// Single Responsibility: all user-visible error/warning text lives here.
// Makes messages testable, consistent, and easy to update.

import * as vscode from 'vscode';

export interface UserMessage {
  text: string;
  actions?: Array<{ label: string; command: string; args?: unknown[] }>;
}

// ─── Message factories ───

export function noWorkspace(): UserMessage {
  return {
    text: 'Please open a folder in VS Code first so MOAG knows where to work.',
    actions: [{ label: 'Open Folder', command: 'vscode.openFolder' }],
  };
}

export function noPlanLoaded(): UserMessage {
  return {
    text: 'No plan is loaded yet. Create a new plan or open an existing one.',
    actions: [
      { label: 'New Plan', command: 'agentTaskPlayer.newPlan' },
      { label: 'Open Plan', command: 'agentTaskPlayer.openPlan' },
    ],
  };
}

export function noPlaylist(): UserMessage {
  return {
    text: 'Your plan needs at least one playlist before you can add tasks.',
    actions: [{ label: 'Add Playlist', command: 'agentTaskPlayer.addPlaylist' }],
  };
}

export function runnerBusy(): UserMessage {
  return {
    text: 'A task is already running. Stop it first, then try again.',
    actions: [{ label: 'Stop', command: 'agentTaskPlayer.stop' }],
  };
}

export function runnerError(detail?: string): UserMessage {
  const hint = detail ? ` (${truncate(detail, 120)})` : '';
  return {
    text: `Something went wrong while running your tasks${hint}. Check the Dashboard for details.`,
    actions: [{ label: 'Show Dashboard', command: 'agentTaskPlayer.showDashboard' }],
  };
}

export function taskFailed(detail?: string): UserMessage {
  const hint = detail ? ` (${truncate(detail, 120)})` : '';
  return {
    text: `Task could not complete successfully${hint}. Open the Dashboard to see what happened.`,
    actions: [{ label: 'Show Dashboard', command: 'agentTaskPlayer.showDashboard' }],
  };
}

export function retryFailed(detail?: string): UserMessage {
  const hint = detail ? `: ${truncate(detail, 120)}` : '';
  return {
    text: `The task retry did not succeed${hint}. Check the Dashboard output for details.`,
    actions: [{ label: 'Show Dashboard', command: 'agentTaskPlayer.showDashboard' }],
  };
}

export function planLoadError(detail?: string): UserMessage {
  const hint = detail ? ` ${truncate(detail, 150)}` : '';
  return {
    text: `Could not read the plan file.${hint}`,
  };
}

export function clipboardEmpty(): UserMessage {
  return {
    text: 'Nothing found on your clipboard. Copy some text first and try again.',
  };
}

export function noHistory(): UserMessage {
  return {
    text: 'Nothing to export yet. Run some tasks first to generate execution history.',
  };
}

export function noCheckpoint(taskName: string): UserMessage {
  return {
    text: `No undo checkpoint exists for "${taskName}". Only recently-run tasks have checkpoints.`,
  };
}

export function undoFailed(detail?: string): UserMessage {
  const hint = detail ? `: ${truncate(detail, 120)}` : '';
  return {
    text: `Could not undo the task changes${hint}. The git history may have been modified since the task ran.`,
  };
}

export function engineNotFound(name: string): UserMessage {
  return {
    text: `Engine "${name}" was not found. Make sure it is installed and available in your PATH.`,
    actions: [
      { label: 'Detect Engines', command: 'agentTaskPlayer.detectEngines' },
    ],
  };
}

export function conversationFailed(detail?: string): UserMessage {
  const hint = detail ? `: ${truncate(detail, 120)}` : '';
  return {
    text: `The conversation could not complete${hint}. Make sure the selected engine is installed and working.`,
    actions: [{ label: 'Detect Engines', command: 'agentTaskPlayer.detectEngines' }],
  };
}

// ─── Display helpers ───

export async function showError(msg: UserMessage): Promise<void> {
  const labels = (msg.actions || []).map(a => a.label);
  const pick = await vscode.window.showErrorMessage(msg.text, ...labels);
  dispatchAction(pick, msg.actions);
}

export async function showWarning(msg: UserMessage): Promise<void> {
  const labels = (msg.actions || []).map(a => a.label);
  const pick = await vscode.window.showWarningMessage(msg.text, ...labels);
  dispatchAction(pick, msg.actions);
}

export async function showInfo(msg: UserMessage): Promise<void> {
  const labels = (msg.actions || []).map(a => a.label);
  const pick = await vscode.window.showInformationMessage(msg.text, ...labels);
  dispatchAction(pick, msg.actions);
}

// ─── Internal helpers ───

function dispatchAction(
  pick: string | undefined,
  actions?: Array<{ label: string; command: string; args?: unknown[] }>,
): void {
  if (!pick || !actions) { return; }
  const action = actions.find(a => a.label === pick);
  if (action) {
    vscode.commands.executeCommand(action.command, ...(action.args || []));
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + '...' : s;
}
