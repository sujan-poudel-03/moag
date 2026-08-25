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
}

function activateExtension(): Registered {
  const ids: string[] = [];
  const subscriptions: unknown[] = [];

  // Record every registration instead of discarding it.
  const originalRegister = vscodeMock.commands.registerCommand;
  vscodeMock.commands.registerCommand = (id: string, _handler: unknown) => {
    ids.push(id);
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

    let ext;
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

  return { ids, disposables: subscriptions.length };
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

  before(() => {
    activated = activateExtension();
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

  it('pushes its registrations onto subscriptions so they are disposed', () => {
    assert.ok(activated.disposables > 0, 'nothing was pushed to context.subscriptions');
  });
});
