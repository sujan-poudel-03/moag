import { strict as assert } from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

interface Shown { kind: 'info' | 'error'; text: string }

function load(answer: string | undefined) {
  const shown: Shown[] = [];
  const clipboard: string[] = [];
  const vscode = {
    ...vscodeMock,
    window: {
      ...vscodeMock.window,
      showInformationMessage: async (text: string, ...rest: unknown[]) => {
        shown.push({ kind: 'info', text });
        // The modal (an options object first) and the POSIX note (a button) get the scripted answer.
        return rest.length > 0 ? answer : undefined;
      },
      showErrorMessage: async (text: string) => { shown.push({ kind: 'error', text }); return undefined; },
    },
    env: { ...vscodeMock.env, clipboard: { writeText: async (t: string) => { clipboard.push(t); } } },
  };
  const mod = proxyquire('../../../ui/cli-install-command', { vscode });
  return { mod, shown, clipboard };
}

const okWrite = (onPath: boolean) => () => ({ written: [], onPath });

describe('MOAG: Install Command-Line Tool', () => {
  it('Windows, not on PATH: declining the modal never touches PATH', async () => {
    const { mod, shown } = load('Not Now');
    let pathCalls = 0;
    await mod.cmdInstallCli({
      extensionPath: 'C:\\ext\\moag.agent-task-player-1.0.0', platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, homedir: 'C:\\U',
      write: okWrite(false), addToPath: async () => { pathCalls++; return true; },
    });
    assert.equal(pathCalls, 0);
    assert.ok(shown.some((s) => /Add C:\\L\\moag\\bin to your user PATH\?/.test(s.text)));
    assert.ok(!shown.some((s) => s.text.startsWith('Installed. Open a new terminal')));
  });

  it('Windows, not on PATH: accepting adds the folder and says to open a new terminal', async () => {
    const { mod, shown } = load('Add to PATH');
    const added: string[] = [];
    await mod.cmdInstallCli({
      extensionPath: 'C:\\ext\\e', platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, homedir: 'C:\\U',
      write: okWrite(false), addToPath: async (d: string) => { added.push(d); return true; },
    });
    assert.deepEqual(added, ['C:\\L\\moag\\bin']);
    assert.ok(shown.some((s) => s.text.includes('moag --version')));
  });

  it('a PATH update that fails shows an error, not success', async () => {
    const { mod, shown } = load('Add to PATH');
    await mod.cmdInstallCli({
      extensionPath: 'C:\\ext\\e', platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, homedir: 'C:\\U',
      write: okWrite(false), addToPath: async () => false,
    });
    assert.ok(shown.some((s) => s.kind === 'error'));
    assert.ok(!shown.some((s) => s.text.startsWith('Installed. Open a new terminal')));
  });

  it('a failed copy shows an error and no success message', async () => {
    const { mod, shown } = load(undefined);
    await mod.cmdInstallCli({
      extensionPath: '/ext/e', platform: 'linux', env: {}, homedir: '/home/a',
      write: () => { throw new Error('EACCES: permission denied'); },
    });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, 'error');
    assert.match(shown[0].text, /EACCES/);
  });

  it('already on PATH: one success message, no prompt', async () => {
    const { mod, shown } = load(undefined);
    await mod.cmdInstallCli({ extensionPath: '/ext/e', platform: 'linux', env: {}, homedir: '/home/a', write: okWrite(true) });
    assert.deepEqual(shown.map((s) => s.kind), ['info']);
    assert.match(shown[0].text, /moag --version/);
  });

  it('macOS, not on PATH: names ~/.zshrc and copies the export line', async () => {
    const { mod, shown, clipboard } = load('Copy');
    await mod.cmdInstallCli({ extensionPath: '/ext/e', platform: 'darwin', env: {}, homedir: '/Users/a', write: okWrite(false) });
    assert.match(shown[0].text, /~\/\.zshrc/);
    assert.deepEqual(clipboard, ['export PATH="$HOME/.local/bin:$PATH"']);
  });

  it('Linux, not on PATH: names ~/.bashrc', async () => {
    const { mod, shown } = load(undefined);
    await mod.cmdInstallCli({ extensionPath: '/ext/e', platform: 'linux', env: {}, homedir: '/home/a', write: okWrite(false) });
    assert.match(shown[0].text, /~\/\.bashrc/);
  });
});
