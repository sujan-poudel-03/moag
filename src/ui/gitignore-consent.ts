// ─── .gitignore consent — ask once per workspace before touching it ───
//
// MOAG keeps its plan and run data in .moag/. Whether any of that belongs in
// git is the user's call: a plan can hold variables and environment values. So
// MOAG asks, once per workspace, and remembers the answer in workspaceState:
//
//   share-plan   ignore run data, keep the plan tracked (.moag/*, !plan files)
//   ignore-all   ignore all of .moag (.moag/)
//   declined     leave .gitignore alone
//   existing     .gitignore already had a .moag rule; nothing was asked
//
// Esc records nothing: MOAG asks again next session. Lines are only ever added,
// never removed, and .gitattributes is never written.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyGitignoreChoice, GitignoreChoice } from '../workspace/moag-paths';

/** workspaceState key holding the answer. */
export const GITIGNORE_DECISION_KEY = 'agentTaskPlayer.gitignoreDecision';

/** Every recorded answer. */
export type GitignoreDecision = 'share-plan' | 'ignore-all' | 'declined' | 'existing';

export const GITIGNORE_PROMPT =
  'MOAG keeps its plan and run data in .moag/. Add ignore rules to this repository\'s .gitignore? ' +
  'Plans can contain variables and environment values. Don\'t share a plan that holds secrets.';

const SHARE_PLAN = 'Ignore run data, share the plan';
const IGNORE_ALL = 'Ignore all of .moag';
const LEAVE = 'Leave .gitignore alone';

/** Esc (or a prompt already on screen): not again this session. */
let dismissedThisSession = false;
let asking = false;

/** Test hook: forget this session's dismissal. */
export function resetGitignoreConsentSession(): void {
  dismissedThisSession = false;
  asking = false;
}

/**
 * Ask whether to add .moag ignore rules, when the workspace is a git repository
 * with a .moag folder, no recorded answer, and no .moag rule in .gitignore yet
 * (an existing rule is recorded as 'existing' without asking).
 */
export async function maybeOfferGitignore(context: Pick<vscode.ExtensionContext, 'workspaceState'>): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || dismissedThisSession || asking) { return; }
  if (context.workspaceState.get<GitignoreDecision>(GITIGNORE_DECISION_KEY)) { return; }
  if (!fs.existsSync(path.join(root, '.git'))) { return; }
  if (!fs.existsSync(path.join(root, '.moag'))) { return; }

  let content = '';
  try { content = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8'); } catch { /* no .gitignore */ }
  if (content.split(/\r?\n/).some((l) => l.trim().startsWith('.moag'))) {
    await context.workspaceState.update(GITIGNORE_DECISION_KEY, 'existing');
    return;
  }

  asking = true;
  let pick: string | undefined;
  try {
    pick = await vscode.window.showInformationMessage(GITIGNORE_PROMPT, SHARE_PLAN, IGNORE_ALL, LEAVE);
  } finally {
    asking = false;
  }
  if (pick === undefined) { dismissedThisSession = true; return; }
  if (pick === LEAVE) {
    await context.workspaceState.update(GITIGNORE_DECISION_KEY, 'declined');
    return;
  }
  const choice: GitignoreChoice = pick === SHARE_PLAN ? 'share-plan' : 'ignore-all';
  try {
    applyGitignoreChoice(root, choice);
  } catch (err) {
    void vscode.window.showWarningMessage(`Could not update .gitignore: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await context.workspaceState.update(GITIGNORE_DECISION_KEY, choice);
}
