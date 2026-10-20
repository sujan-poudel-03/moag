// Global unit-test bootstrap (loaded via `mocha --require`).
//
// Installs a MOAG host backed by the in-memory `vscode` mock so the engine core
// can read configuration in tests exactly as it does in production. Tests keep
// driving config through `vscodeMock.setMockConfig(...)` — the host reads the
// same backing store at call time.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setHost } from '../../core/host';

// Never let a test see the developer's real MOAG user config. `moag run` and `moag daemon` read
// the ONOSOO device key from MOAG_ONOSOO_* or <configDir>/moag/onosoo.json (%APPDATA% on Windows,
// $XDG_CONFIG_HOME or ~/.config elsewhere). On a machine that is really paired, a test that runs
// cmdRun without injecting `relayDeps.env` would otherwise relay its fake runs to the live ONOSOO
// and behave differently (it once made the ship-gate test hang). Every test gets an empty config
// home instead; tests that need a relay inject their own env.
const isolatedConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-test-config-'));
process.env.APPDATA = isolatedConfigHome;
process.env.XDG_CONFIG_HOME = isolatedConfigHome;
delete process.env.MOAG_ONOSOO_KEY;
delete process.env.MOAG_ONOSOO_URL;
process.on('exit', () => {
  try { fs.rmSync(isolatedConfigHome, { recursive: true, force: true }); } catch { /* best effort */ }
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('./mocks/vscode');

setHost({
  getConfiguration: (section: string) => vscodeMock.workspace.getConfiguration(section),
  warn: () => { /* no-op in tests */ },
  workspaceRoot: () => vscodeMock.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '/mock/workspace',
});
