import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const KEY = 'agentTaskPlayer.gitignoreDecision';

function memento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(k: string, d?: T) => (store.has(k) ? store.get(k) as T : d),
    update: async (k: string, v: unknown) => { store.set(k, v); },
  };
}

describe('gitignore consent', () => {
  let root: string;
  let asked: number;
  let answer: string | undefined;
  let mod: {
    maybeOfferGitignore(c: unknown): Promise<void>;
    resetGitignoreConsentSession(): void;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-consent-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.moag'));
    asked = 0;
    answer = undefined;
    const vscode = {
      ...vscodeMock,
      workspace: { ...vscodeMock.workspace, workspaceFolders: [{ uri: { fsPath: root } }] },
      window: {
        ...vscodeMock.window,
        showInformationMessage: async () => { asked++; return answer; },
        showWarningMessage: async () => undefined,
      },
    };
    // moag-paths imports vscode too: load the real module against the mock.
    const paths = proxyquire('../../../workspace/moag-paths', { vscode: vscodeMock });
    mod = proxyquire('../../../ui/gitignore-consent', { vscode, '../workspace/moag-paths': paths });
    mod.resetGitignoreConsentSession();
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const gitignore = (): string | null => {
    const f = path.join(root, '.gitignore');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
  };

  it('share the plan: writes the three lines and records share-plan', async () => {
    answer = 'Ignore run data, share the plan';
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(gitignore(), '.moag/*\n!.moag/plan.json\n!.moag/.agent-plan.json\n');
    assert.equal(ws.store.get(KEY), 'share-plan');
    assert.equal(fs.existsSync(path.join(root, '.gitattributes')), false, 'never writes .gitattributes');
  });

  it('ignore all: writes .moag/ and records ignore-all; asked once per workspace', async () => {
    answer = 'Ignore all of .moag';
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(gitignore(), '.moag/\n');
    assert.equal(ws.store.get(KEY), 'ignore-all');
    assert.equal(asked, 1);
  });

  it('leave it alone: no write, records declined', async () => {
    answer = 'Leave .gitignore alone';
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(gitignore(), null);
    assert.equal(ws.store.get(KEY), 'declined');
  });

  it('Esc: no write, nothing recorded, and not asked again this session', async () => {
    answer = undefined;
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(gitignore(), null);
    assert.equal(ws.store.has(KEY), false);
    assert.equal(asked, 1);
  });

  it('no prompt outside a git repository', async () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(asked, 0);
    assert.equal(ws.store.has(KEY), false);
  });

  it('an existing .moag line records "existing" without asking, and changes nothing', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n  .moag/\n');
    const ws = memento();
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(asked, 0);
    assert.equal(ws.store.get(KEY), 'existing');
    assert.equal(gitignore(), 'node_modules/\n  .moag/\n');
  });

  it('a recorded answer is never asked again', async () => {
    const ws = memento({ [KEY]: 'declined' });
    await mod.maybeOfferGitignore({ workspaceState: ws });
    assert.equal(asked, 0);
  });
});
