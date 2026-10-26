import { strict as assert } from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const SECRET = 'agentTaskPlayer.anthropicApiKey';
const Target = vscodeMock.ConfigurationTarget as { Global: number; Workspace: number; WorkspaceFolder: number };

interface Scopes { global?: string; workspace?: string; folder?: string }

interface World {
  mod: {
    migrateAnthropicKeySetting(c: unknown): Promise<void>;
    cmdSetAnthropicKey(c: unknown): Promise<void>;
    cmdClearAnthropicKey(c: unknown): Promise<void>;
  };
  scopes: Scopes;
  updates: Array<{ target: number; value: unknown }>;
  notices: string[];
  secrets: Map<string, string>;
  stores: string[];
  context: { secrets: { get(k: string): Promise<string | undefined>; store(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } };
  input: { value: string | undefined; options?: Record<string, unknown> };
  confirm: { value: string | undefined };
}

function world(initial: Scopes, opts: { secret?: string; storeRejects?: boolean } = {}): World {
  const scopes: Scopes = { ...initial };
  const updates: World['updates'] = [];
  const notices: string[] = [];
  const secrets = new Map<string, string>();
  if (opts.secret) { secrets.set(SECRET, opts.secret); }
  const stores: string[] = [];
  const input: World['input'] = { value: undefined };
  const confirm: World['confirm'] = { value: undefined };

  const getConfiguration = (_section: string, scopeUri?: unknown) => ({
    inspect: () => (scopeUri
      ? { workspaceFolderValue: scopes.folder }
      : { globalValue: scopes.global, workspaceValue: scopes.workspace }),
    update: async (_key: string, value: unknown, target: number) => {
      updates.push({ target, value });
      if (target === Target.Global) { scopes.global = undefined; }
      if (target === Target.Workspace) { scopes.workspace = undefined; }
      if (target === Target.WorkspaceFolder) { scopes.folder = undefined; }
    },
  });

  const vscode = {
    ...vscodeMock,
    workspace: { ...vscodeMock.workspace, getConfiguration, workspaceFolders: [{ name: 'app', uri: vscodeMock.Uri.file('/w/app') }] },
    window: {
      ...vscodeMock.window,
      showWarningMessage: async (msg: string, ...rest: unknown[]) => {
        if (rest.length && typeof rest[0] === 'object') { return confirm.value; }
        notices.push(msg); return undefined;
      },
      showInformationMessage: async (msg: string) => { notices.push(msg); return undefined; },
      showErrorMessage: async (msg: string) => { notices.push(msg); return undefined; },
      showInputBox: async (o: Record<string, unknown>) => { input.options = o; return input.value; },
    },
  };
  const mod = proxyquire('../../../ui/anthropic-key', { vscode });
  const context = {
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => {
        if (opts.storeRejects) { throw new Error('keychain unavailable'); }
        stores.push(v); secrets.set(k, v);
      },
      delete: async (k: string) => { secrets.delete(k); },
    },
  };
  return { mod, scopes, updates, notices, secrets, stores, context, input, confirm };
}

describe('Anthropic key: settings migration', () => {
  it('moves a user-settings key into secret storage, clears it, and names User settings', async () => {
    const w = world({ global: 'sk-ant-global-key-1234' });
    await w.mod.migrateAnthropicKeySetting(w.context);
    assert.equal(w.secrets.get(SECRET), 'sk-ant-global-key-1234');
    assert.deepEqual(w.updates, [{ target: Target.Global, value: undefined }]);
    assert.equal(w.notices.length, 1);
    assert.match(w.notices[0], /User settings/);
    assert.doesNotMatch(w.notices[0], /rotate/);
  });

  it('a workspace key produces a notice that says to rotate it', async () => {
    const w = world({ workspace: 'sk-ant-workspace-key-1' });
    await w.mod.migrateAnthropicKeySetting(w.context);
    assert.match(w.notices[0], /Workspace settings/);
    assert.match(w.notices[0], /rotate/);
  });

  it('the folder value beats workspace and user, and every scope is cleared', async () => {
    const w = world({ global: 'sk-ant-global-key-1234', workspace: 'sk-ant-workspace-key-1', folder: 'sk-ant-folder-key-12345' });
    await w.mod.migrateAnthropicKeySetting(w.context);
    assert.equal(w.secrets.get(SECRET), 'sk-ant-folder-key-12345');
    assert.deepEqual(w.updates.map((u) => u.target).sort(), [Target.Global, Target.Workspace, Target.WorkspaceFolder].sort());
    assert.match(w.notices[0], /Folder settings \(app\)/);
  });

  it('an existing secret is not overwritten, but the scopes are still cleared', async () => {
    const w = world({ global: 'sk-ant-global-key-1234' }, { secret: 'sk-ant-already-stored' });
    await w.mod.migrateAnthropicKeySetting(w.context);
    assert.equal(w.secrets.get(SECRET), 'sk-ant-already-stored');
    assert.deepEqual(w.stores, []);
    assert.equal(w.updates.length, 1);
    assert.equal(w.notices.length, 1);
  });

  it('with no value anywhere: no store, no update, no notice', async () => {
    const w = world({});
    await w.mod.migrateAnthropicKeySetting(w.context);
    assert.deepEqual(w.stores, []);
    assert.deepEqual(w.updates, []);
    assert.deepEqual(w.notices, []);
  });

  it('the notice never contains the key', async () => {
    const w = world({ global: 'sk-ant-global-key-1234', workspace: 'sk-ant-workspace-key-1' });
    await w.mod.migrateAnthropicKeySetting(w.context);
    for (const n of w.notices) {
      assert.ok(!n.includes('sk-ant-global-key-1234') && !n.includes('sk-ant-workspace-key-1'), n);
    }
  });

  it('when storing fails, the setting is not cleared', async () => {
    const w = world({ global: 'sk-ant-global-key-1234' }, { storeRejects: true });
    await assert.rejects(w.mod.migrateAnthropicKeySetting(w.context), /keychain unavailable/);
    assert.deepEqual(w.updates, []);
    assert.equal(w.scopes.global, 'sk-ant-global-key-1234');
  });

  it('a failed run does not block the next one', async () => {
    const w = world({ global: 'sk-ant-global-key-1234' }, { storeRejects: true });
    await assert.rejects(w.mod.migrateAnthropicKeySetting(w.context));
    w.scopes.global = undefined;
    await w.mod.migrateAnthropicKeySetting(w.context); // resolves
  });
});

describe('Anthropic key: commands', () => {
  it('Set stores the trimmed key from a masked input and never shows it', async () => {
    const w = world({});
    w.input.value = '  sk-ant-typed-in-key-99  ';
    await w.mod.cmdSetAnthropicKey(w.context);
    assert.equal(w.secrets.get(SECRET), 'sk-ant-typed-in-key-99');
    assert.equal(w.input.options?.password, true);
    assert.equal(w.input.options?.ignoreFocusOut, true);
    for (const n of w.notices) { assert.ok(!n.includes('sk-ant-typed-in-key-99')); }
  });

  it('Set validates the key shape', async () => {
    const w = world({});
    w.input.value = undefined;
    await w.mod.cmdSetAnthropicKey(w.context);
    const validate = w.input.options?.validateInput as (v: string) => string | null;
    assert.equal(validate('sk-ant-valid-key'), null);
    assert.ok(validate('has space in it'));
    assert.ok(validate('short'));
    assert.deepEqual(w.stores, [], 'a cancelled input stores nothing');
  });

  it('Clear deletes only after the modal is confirmed', async () => {
    const w = world({}, { secret: 'sk-ant-already-stored' });
    w.confirm.value = undefined;
    await w.mod.cmdClearAnthropicKey(w.context);
    assert.equal(w.secrets.get(SECRET), 'sk-ant-already-stored');
    w.confirm.value = 'Clear';
    await w.mod.cmdClearAnthropicKey(w.context);
    assert.equal(w.secrets.get(SECRET), undefined);
  });
});
