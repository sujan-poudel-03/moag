import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const KEY = 'onosoo-device-key-DIAG4444';

describe('MOAG: Export Diagnostics (command)', () => {
  let tmp: string;
  let moagDir: string;
  let target: string;
  let saveAnswer: unknown;
  let saveOptions: { defaultUri?: { fsPath: string } } | null;
  let opened: string[];
  let errors: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-cmd-'));
    moagDir = path.join(tmp, '.moag');
    fs.mkdirSync(moagDir);
    fs.writeFileSync(path.join(moagDir, 'errors.jsonl'),
      JSON.stringify({ ts: '2026-10-26T00:00:00Z', category: 'github', message: `auth failed for ${KEY}` }) + '\n');
    target = path.join(tmp, 'out', 'diag.md');
    fs.mkdirSync(path.dirname(target));
    saveAnswer = vscodeMock.Uri.file(target);
    saveOptions = null;
    opened = [];
    errors = [];
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function load() {
    const vscode = {
      ...vscodeMock,
      window: {
        ...vscodeMock.window,
        showSaveDialog: async (o: { defaultUri?: { fsPath: string } }) => { saveOptions = o; return saveAnswer; },
        showErrorMessage: async (m: string) => { errors.push(m); return undefined; },
        showTextDocument: async () => undefined,
      },
      workspace: {
        ...vscodeMock.workspace,
        workspaceFolders: [{ uri: { fsPath: tmp } }],
        openTextDocument: async (u: { fsPath: string }) => { opened.push(u.fsPath); return {}; },
      },
    };
    return proxyquire('../../../ui/diagnostics-command', {
      vscode,
      '../adapters/index': { checkEngineAvailability: async () => new Map([['claude', { available: true, version: '1.2.3' }]]) },
      '../workspace/moag-paths': { getMoagDir: () => moagDir },
      '../headless/host-run-relay': { probeRelayStatus: () => 'none' },
      '../headless/onosoo-config': { resolveOnosooConfig: () => null, userConfigDir: () => tmp },
    });
  }

  const deps = { context: { extension: { packageJSON: { version: '9.9.9', contributes: {} } } }, relayEnv: {}, extraSecrets: async () => [KEY] };

  it('writes a redacted report where the user chose, defaulting to the home folder, then opens it', async () => {
    await load().cmdExportDiagnostics(deps);
    const text = fs.readFileSync(target, 'utf-8');
    assert.match(text, /^# MOAG diagnostics/);
    assert.match(text, /\| MOAG \| 9\.9\.9 \|/);
    assert.match(text, /auth failed for/);
    assert.ok(!text.includes(KEY), 'the device key reached the diagnostics file');
    assert.equal(path.dirname(saveOptions!.defaultUri!.fsPath), os.homedir());
    assert.match(path.basename(saveOptions!.defaultUri!.fsPath), /^moag-diagnostics-\d{8}-\d{4}\.md$/);
    assert.deepEqual(opened, [target]);
  });

  it('a cancelled save dialog writes nothing', async () => {
    saveAnswer = undefined;
    await load().cmdExportDiagnostics(deps);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(opened, []);
  });

  it('a failed write shows an error and opens nothing', async () => {
    saveAnswer = vscodeMock.Uri.file(path.join(tmp, 'missing-dir', 'diag.md'));
    await load().cmdExportDiagnostics(deps);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Could not save the diagnostics/);
    assert.deepEqual(opened, []);
  });
});
