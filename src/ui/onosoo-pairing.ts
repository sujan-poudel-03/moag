// ─── ONOSOO pairing commands — Connect / Disconnect ───
//
// The VS Code side of src/headless/onosoo-pair.ts. Connect asks for the device
// key (masked), saves it, checks it with ONOSOO, and refreshes the status bar
// without a restart. Disconnect removes the saved key, never mid-run.

import * as vscode from 'vscode';
import { API_KEY_RE } from '../shared/engine-keys';
import {
  checkPairing, inspectPairing, PairError, PairingLocation, removePairing, writePairing,
} from '../headless/onosoo-pair';
import type { RelayHttpClient } from '../headless/onosoo-relay';
import type { RelayEnvSnapshot } from '../headless/run-reporter';
import type { execFileAsync } from '../utils/exec-file';

/** What the commands need from activate(). */
export interface OnosooPairingDeps {
  /** The relay variables activate() took out of process.env. */
  relayEnv: RelayEnvSnapshot;
  /** Re-read the pairing and redraw the status bar. */
  reprobe(): void;
  /** True while a run is being relayed. */
  isLive(): boolean;
  http?: RelayHttpClient;
  exec?: typeof execFileAsync;
  /** Where the pairing file lives (tests). Default: this user's config dir. */
  location?: PairingLocation;
}

const ENV_OVERRIDE_NOTE = 'MOAG_ONOSOO_KEY in this environment overrides the saved key.';

function location(deps: OnosooPairingDeps): PairingLocation {
  return deps.location ?? { env: process.env };
}

/**
 * Connect this machine to ONOSOO Builds. An optional `{ url }` argument (from a
 * walkthrough link or another extension) overrides the default backend URL.
 */
export async function cmdConnectOnosoo(deps: OnosooPairingDeps, arg?: { url?: unknown }): Promise<void> {
  const raw = await vscode.window.showInputBox({
    title: 'Connect to ONOSOO Builds',
    prompt: 'ONOSOO device key (Builds › Pair machine)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v: string) => (API_KEY_RE.test(v.trim()) ? null : 'A device key is 8–512 printable characters with no spaces.'),
  });
  const key = raw?.trim();
  if (!key) { return; }
  const url = typeof arg?.url === 'string' && arg.url.length > 0 ? arg.url : undefined;
  const loc = location(deps);

  const before = inspectPairing({ ...loc, key });
  if (before.keyChanged && before.unsentEvents > 0) {
    const n = before.unsentEvents;
    const go = await vscode.window.showWarningMessage(
      `${n} unsent run event${n === 1 ? '' : 's'} from the previous pairing will be discarded.`,
      { modal: true },
      'Connect',
    );
    if (go !== 'Connect') { return; }
  }

  let saved: Awaited<ReturnType<typeof writePairing>>['saved'];
  try {
    ({ saved } = await writePairing({ ...loc, key, url, exec: deps.exec }));
  } catch (err) {
    const msg = err instanceof PairError ? err.message : 'Could not save the ONOSOO pairing.';
    void vscode.window.showErrorMessage(msg);
    return;
  }

  // Check the key just saved, not an environment override.
  const outcome = await checkPairing(saved, deps.http);
  try { deps.reprobe(); } catch { /* the status bar never blocks the outcome */ }

  if (deps.relayEnv.MOAG_ONOSOO_KEY) { void vscode.window.showWarningMessage(ENV_OVERRIDE_NOTE); }

  if (outcome === 'accepted') {
    void vscode.window.showInformationMessage('Connected to ONOSOO Builds.');
  } else if (outcome === 'refused') {
    const again = await vscode.window.showWarningMessage(
      'Saved, but ONOSOO refused the key: it was revoked or mistyped. Pair again with a new key.',
      'Try Again',
    );
    if (again === 'Try Again') { void vscode.commands.executeCommand('agentTaskPlayer.connectOnosoo', arg); }
  } else {
    void vscode.window.showInformationMessage(
      `Saved. Could not confirm with ONOSOO (${outcome.unverified}); runs will relay when it is reachable.`,
    );
  }
}

/** Disconnect this machine: remove the saved key, keep the device id. Refused while a run relays. */
export async function cmdDisconnectOnosoo(deps: OnosooPairingDeps): Promise<void> {
  if (deps.isLive()) {
    void vscode.window.showWarningMessage('A run is being relayed; disconnect after it ends.');
    return;
  }
  const go = await vscode.window.showWarningMessage(
    'Disconnect this machine from ONOSOO Builds? The saved device key is removed, and unsent run events are discarded.',
    { modal: true },
    'Disconnect',
  );
  if (go !== 'Disconnect') { return; }
  const removed = removePairing(location(deps));
  try { deps.reprobe(); } catch { /* ignore */ }
  if (!removed) {
    void vscode.window.showInformationMessage('This machine is not paired with ONOSOO.');
    return;
  }
  void vscode.window.showInformationMessage(
    deps.relayEnv.MOAG_ONOSOO_KEY
      ? `Disconnected from ONOSOO. ${ENV_OVERRIDE_NOTE.replace('overrides the saved key', 'still pairs this window until VS Code restarts without it')}`
      : 'Disconnected from ONOSOO.',
  );
}
