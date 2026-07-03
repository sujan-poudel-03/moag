// Global unit-test bootstrap (loaded via `mocha --require`).
//
// Installs a MOAG host backed by the in-memory `vscode` mock so the engine core
// can read configuration in tests exactly as it does in production. Tests keep
// driving config through `vscodeMock.setMockConfig(...)` — the host reads the
// same backing store at call time.

import { setHost } from '../../core/host';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('./mocks/vscode');

setHost({
  getConfiguration: (section: string) => vscodeMock.workspace.getConfiguration(section),
  warn: () => { /* no-op in tests */ },
  workspaceRoot: () => vscodeMock.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '/mock/workspace',
});
