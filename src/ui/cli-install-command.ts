// ─── MOAG: Install Command-Line Tool ───
//
// The VS Code side of src/headless/cli-install.ts: consent and messages. Puts a
// `moag` command on PATH that runs the CLI bundled in the newest installed
// extension, so `moag pair`, `moag daemon` and `moag run` work in a terminal.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addToWindowsUserPath, planInstall, writeInstall } from '../headless/cli-install';

/** What the command needs; injectable for tests. */
export interface CliInstallDeps {
  extensionPath: string;
  /** VS Code's executable, recorded for the ELECTRON_RUN_AS_NODE fallback. */
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  addToPath?: typeof addToWindowsUserPath;
  write?: typeof writeInstall;
}

const DONE_TEXT = 'Installed. Open a new terminal (restart VS Code for its own terminals) and run `moag --version`.';

/** Install the `moag` command for this user. */
export async function cmdInstallCli(deps: CliInstallDeps): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const plan = planInstall({
    platform,
    env: deps.env ?? process.env,
    homedir: deps.homedir ?? os.homedir(),
    extensionPath: deps.extensionPath,
    execPath: deps.execPath ?? process.execPath,
  });
  const launcherSrc = path.join(deps.extensionPath, 'out', 'headless', 'moag-launch.js');
  const ps1 = path.join(deps.extensionPath, 'scripts', 'install-daemon-windows.ps1');

  let result: ReturnType<typeof writeInstall>;
  try {
    result = (deps.write ?? writeInstall)(plan, launcherSrc, fs.existsSync(ps1) ? ps1 : undefined);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not install the MOAG command-line tool: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (result.onPath) {
    void vscode.window.showInformationMessage(DONE_TEXT);
    return;
  }

  if (platform === 'win32') {
    const choice = await vscode.window.showInformationMessage(
      `Add ${plan.binDir} to your user PATH?`,
      { modal: true, detail: 'Without it, run the tool by its full path: ' + plan.shimPath },
      'Add to PATH',
      'Not Now',
    );
    if (choice !== 'Add to PATH') {
      void vscode.window.showInformationMessage(`Installed at ${plan.shimPath}. It is not on PATH, so run it by that full path.`);
      return;
    }
    const outcome = await (deps.addToPath ?? addToWindowsUserPath)(plan.binDir);
    if (outcome === 'failed') {
      void vscode.window.showErrorMessage(`Installed, but ${plan.binDir} could not be added to your user PATH. Add it in System Properties › Environment Variables.`);
      return;
    }
    if (outcome === 'restart-terminals') {
      void vscode.window.showInformationMessage('Installed. PATH updated; restart terminals (and VS Code, for its own terminals) to pick it up, then run `moag --version`.');
      return;
    }
    void vscode.window.showInformationMessage(DONE_TEXT);
    return;
  }

  const rc = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  const choice = await vscode.window.showInformationMessage(
    `Installed at ${plan.shimPath}, but ~/.local/bin is not on your PATH. Add this line to ${rc}, then open a new terminal: ${line}`,
    'Copy',
  );
  if (choice === 'Copy') { await vscode.env.clipboard.writeText(line); }
}
