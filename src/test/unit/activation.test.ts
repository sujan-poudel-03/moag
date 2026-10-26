import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('./mocks/vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require('../../../package.json');

/**
 * The safety net for taking extension.ts apart.
 *
 * It is 9,000 lines of command wiring, and nothing in the type system connects
 * a `registerCommand` call to the manifest entry that surfaces it. Splitting it
 * without this test means a dropped registration ships as a button that does
 * nothing — which this repo has already done four separate times.
 *
 * So: load the real module, run the real activate(), and check that every
 * command the manifest promises actually got registered.
 */

interface Registered {
  ids: string[];
  disposables: number;
  ext: { activate: (c: unknown) => void; deactivate: () => void };
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

function activateExtension(): Registered {
  const ids: string[] = [];
  const subscriptions: unknown[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let ext;

  // Record every registration instead of discarding it.
  const originalRegister = vscodeMock.commands.registerCommand;
  vscodeMock.commands.registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
    ids.push(id);
    handlers.set(id, handler);
    return { dispose: () => { /* no-op */ } };
  };

  try {
    // proxyquire only substitutes for the module it loads directly; extension.ts
    // pulls in adapters and stores that require('vscode') themselves. So hook the
    // loader the same way install-shim does for the headless CLI.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') { return vscodeMock; }
      return originalLoad.call(Module, request, parent, isMain);
    };

    try {
      ext = require('../../extension');
    } finally {
      Module._load = originalLoad;
    }
    assert.strictEqual(typeof ext.activate, 'function', 'extension must export activate()');
    assert.strictEqual(typeof ext.deactivate, 'function', 'extension must export deactivate()');

    ext.activate({
      subscriptions,
      extensionUri: vscodeMock.Uri.file('/mock/ext'),
      extensionPath: '/mock/ext',
      globalState: memento(),
      workspaceState: memento(),
      globalStorageUri: vscodeMock.Uri.file('/mock/global'),
      extension: { packageJSON: manifest },
    });
  } finally {
    vscodeMock.commands.registerCommand = originalRegister;
  }

  return { ids, disposables: subscriptions.length, ext: ext as Registered['ext'], handlers };
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string, d?: T) => (store.has(k) ? (store.get(k) as T) : d),
    update: async (k: string, v: unknown) => { store.set(k, v); },
    keys: () => [...store.keys()],
    setKeysForSync: () => { /* no-op */ },
  };
}

describe('Extension activation', () => {
  let activated: Registered;
  let keyAfter: string | undefined;
  let uncaughtBefore = 0;
  let rejectionBefore = 0;

  // This hook loads extension.ts and its entire dependency tree through ts-node
  // and then runs activate(). On a loaded machine that exceeds mocha default 2s,
  // which showed up as an intermittent failure rather than a real defect.
  before(function () {
    this.timeout(60_000);
    // A device key with no URL: activation must take it out of process.env (never relayed here).
    process.env.MOAG_ONOSOO_KEY = 'test-only-key-1234';
    uncaughtBefore = process.listenerCount('uncaughtException');
    rejectionBefore = process.listenerCount('unhandledRejection');
    activated = activateExtension();
    keyAfter = process.env.MOAG_ONOSOO_KEY;
  });

  after(() => {
    delete process.env.MOAG_ONOSOO_KEY;
  });

  it('activates without throwing', () => {
    assert.ok(activated.ids.length > 0, 'activate() registered no commands at all');
  });

  it('registers every command the manifest promises', () => {
    const declared: string[] = manifest.contributes.commands
      .map((c: { command: string }) => c.command)
      .filter((id: string) => id.startsWith('agentTaskPlayer.'));
    const registered = new Set(activated.ids);

    // A manifest entry with no registration is a palette item that errors when
    // invoked, which is exactly the class of bug this file exists to prevent.
    const missing = declared.filter((id) => !registered.has(id)).sort();
    assert.deepStrictEqual(missing, [],
      'declared in package.json but never registered — these would fail when invoked');
  });

  it('registers no command twice', () => {
    const seen = new Set<string>();
    const dupes = activated.ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    assert.deepStrictEqual([...new Set(dupes)], [],
      'a duplicate registration means the second one silently wins');
  });

  it('takes the ONOSOO device key out of process.env at activation', () => {
    assert.strictEqual(keyAfter, undefined, 'a child process spawned by this host would inherit the device key');
  });

  it('pushes its registrations onto subscriptions so they are disposed', () => {
    assert.ok(activated.disposables > 0, 'nothing was pushed to context.subscriptions');
  });

  it('refuses to verify against the PRD without a workspace, before touching the runner', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TaskRunner } = require('../../runner/runner');
    const originalFolders = vscodeMock.workspace.workspaceFolders;
    const originalError = vscodeMock.window.showErrorMessage;
    const originalOn = TaskRunner.prototype.on;
    const errors: string[] = [];
    let onCalls = 0;
    vscodeMock.workspace.workspaceFolders = undefined;
    vscodeMock.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(undefined); };
    TaskRunner.prototype.on = function (...args: unknown[]) { onCalls++; return originalOn.apply(this, args); };
    try {
      const handler = activated.handlers.get('agentTaskPlayer.verifyAgainstPrd');
      assert.ok(handler, 'verifyAgainstPrd is not registered');
      await handler();
    } finally {
      vscodeMock.workspace.workspaceFolders = originalFolders;
      vscodeMock.window.showErrorMessage = originalError;
      TaskRunner.prototype.on = originalOn;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { noWorkspace } = require('../../utils/user-messages');
    assert.deepStrictEqual(errors, [noWorkspace().text]);
    assert.strictEqual(onCalls, 0, 'a runner listener was attached with no workspace open');
  });

  // Keep this last: deactivate() tears down module state the other tests read.
  it('installs process error handlers and removes them on deactivate', () => {
    assert.strictEqual(process.listenerCount('uncaughtException'), uncaughtBefore + 1);
    assert.strictEqual(process.listenerCount('unhandledRejection'), rejectionBefore + 1);
    activated.ext.deactivate();
    assert.strictEqual(process.listenerCount('uncaughtException'), uncaughtBefore,
      'an uncaughtException handler survived deactivate()');
    assert.strictEqual(process.listenerCount('unhandledRejection'), rejectionBefore,
      'an unhandledRejection handler survived deactivate()');
  });
});
