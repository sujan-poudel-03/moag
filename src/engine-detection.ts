// ─── Auto-detect installed CLI engines during onboarding ───

import * as vscode from 'vscode';
import { EngineId } from './models/types';
import { checkEngineAvailability, EngineAvailability } from './adapters/engine';

/** Priority-ordered list of built-in engines to detect (skip 'custom'). */
export const ENGINE_PRIORITY: EngineId[] = ['claude', 'codex', 'gemini', 'ollama'];

/** Result of engine detection scan. */
export interface DetectionResult {
  /** Map of engine ID → availability info */
  availability: Map<EngineId, EngineAvailability>;
  /** Engines that were found on the system */
  available: EngineId[];
  /** Highest-priority available engine, or null if none found */
  autoSelected: EngineId | null;
}

/**
 * Pure detection: scan PATH for known CLIs and return results.
 * Does not modify any configuration or state.
 */
export async function detectEngines(): Promise<DetectionResult> {
  const availability = await checkEngineAvailability(ENGINE_PRIORITY);

  const available: EngineId[] = ENGINE_PRIORITY.filter(
    (id) => availability.get(id)?.available === true,
  );

  const autoSelected = available.length > 0 ? available[0] : null;

  return { availability, available, autoSelected };
}

/**
 * One-time onboarding flow: detect engines, auto-set default, and inform user.
 * Guarded by `agentTaskPlayer.engineDetectionDone` in globalState — runs only once.
 */
export async function detectAndConfigureEngines(
  context: vscode.ExtensionContext,
): Promise<void> {
  const done = context.globalState.get<boolean>('agentTaskPlayer.engineDetectionDone', false);
  if (done) {
    return;
  }

  const result = await detectEngines();

  // Mark as done so we don't re-run on subsequent activations
  await context.globalState.update('agentTaskPlayer.engineDetectionDone', true);

  // Store detection results for potential later use
  await context.globalState.update(
    'agentTaskPlayer.detectedEngines',
    result.available,
  );

  if (result.autoSelected) {
    // Only override the default if the user hasn't explicitly configured it
    const config = vscode.workspace.getConfiguration('agentTaskPlayer');
    const inspection = config.inspect<string>('defaultEngine');
    const userHasConfigured =
      inspection?.globalValue !== undefined ||
      inspection?.workspaceValue !== undefined ||
      inspection?.workspaceFolderValue !== undefined;

    if (!userHasConfigured) {
      await config.update('defaultEngine', result.autoSelected, vscode.ConfigurationTarget.Global);
    }

    const names = result.available.map(
      (id) => result.availability.get(id)?.displayName ?? id,
    );

    const action = await vscode.window.showInformationMessage(
      `Detected ${names.join(', ')}. Auto-selected ${result.availability.get(result.autoSelected)?.displayName ?? result.autoSelected} as default engine.`,
      'Change Default',
    );

    if (action === 'Change Default') {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'agentTaskPlayer.defaultEngine',
      );
    }
  } else {
    const action = await vscode.window.showWarningMessage(
      'No supported CLI engines were detected. Install at least one to get started.',
      'Open Walkthrough',
      'Open Settings',
    );

    if (action === 'Open Walkthrough') {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'moag.agent-task-player#agentTaskPlayer.getStarted',
        false,
      );
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'agentTaskPlayer.engines',
      );
    }
  }
}

/**
 * Re-runnable detection: scan for engines and show results.
 * No guard, no config auto-set — just detection + info message.
 */
export async function redetectEngines(
  context: vscode.ExtensionContext,
): Promise<void> {
  const result = await detectEngines();

  // Update stored results
  await context.globalState.update(
    'agentTaskPlayer.detectedEngines',
    result.available,
  );

  if (result.available.length > 0) {
    const names = result.available.map(
      (id) => result.availability.get(id)?.displayName ?? id,
    );

    vscode.window.showInformationMessage(
      `Detected engines: ${names.join(', ')}. Current default: ${vscode.workspace.getConfiguration('agentTaskPlayer').get('defaultEngine')}.`,
      'Change Default',
    ).then((action) => {
      if (action === 'Change Default') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'agentTaskPlayer.defaultEngine',
        );
      }
    });
  } else {
    vscode.window.showWarningMessage(
      'No supported CLI engines were detected on your system.',
      'Open Settings',
    ).then((action) => {
      if (action === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'agentTaskPlayer.engines',
        );
      }
    });
  }
}
