import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The headless shim reads `.moag/config.json`. It used to walk a dotted setting
 * id segment by segment, which only ever matched a FULLY nested object — so the
 * shape VS Code itself writes returned the default instead of the value.
 *
 * That is silent and it is severe: `git.autoCommit` reading false means an
 * unattended run does a night of work and commits none of it, and the same
 * applies to the cost ceiling, timeouts and gate commands.
 */
function readSetting(cfg: unknown, section: string, key: string, fallback: unknown): unknown {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-cfg-'));
  fs.mkdirSync(path.join(dir, '.moag'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.moag', 'config.json'), JSON.stringify(cfg), 'utf-8');

  // Talk to the shim module directly. installVscodeShim() must NOT be called
  // here: it hooks Module._load globally and never uninstalls, so every later
  // require('vscode') in the process would resolve to the headless shim instead
  // of the test mock — which silently broke 65 runner tests downstream.
  // __setWorkspaceRoot already invalidates the config cache, so this is enough.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shim = require('../../../headless/vscode-shim');
  shim.__setWorkspaceRoot(dir);
  try {
    return shim.workspace.getConfiguration(section).get(key, fallback);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('headless config — every shape a config file is written in', () => {
  it('reads a flat top-level key, the shape VS Code settings.json uses', () => {
    assert.strictEqual(
      readSetting({ 'agentTaskPlayer.git.autoCommit': true }, 'agentTaskPlayer', 'git.autoCommit', false),
      true,
    );
  });

  it('reads a sectioned object with a flat key inside it', () => {
    assert.strictEqual(
      readSetting({ agentTaskPlayer: { 'git.autoCommit': true } }, 'agentTaskPlayer', 'git.autoCommit', false),
      true,
    );
  });

  it('reads a fully nested object', () => {
    assert.strictEqual(
      readSetting({ agentTaskPlayer: { git: { autoCommit: true } } }, 'agentTaskPlayer', 'git.autoCommit', false),
      true,
    );
  });

  it('still returns the fallback when the key is genuinely absent', () => {
    assert.strictEqual(
      readSetting({ agentTaskPlayer: { other: 1 } }, 'agentTaskPlayer', 'git.autoCommit', false),
      false,
    );
  });

  it('reads a single-segment key unchanged', () => {
    assert.strictEqual(
      readSetting({ agentTaskPlayer: { fullAuto: true } }, 'agentTaskPlayer', 'fullAuto', false),
      true,
    );
  });

  it('does not confuse a falsy stored value with an absent one', () => {
    // `false` and `0` are meaningful settings; returning the fallback for them
    // would make a deliberately-disabled feature look unset.
    assert.strictEqual(
      readSetting({ 'agentTaskPlayer.git.autoCommit': false }, 'agentTaskPlayer', 'git.autoCommit', true),
      false,
    );
    assert.strictEqual(
      readSetting({ agentTaskPlayer: { costBudgetUsd: 0 } }, 'agentTaskPlayer', 'costBudgetUsd', 25),
      0,
    );
  });

  it('prefers an explicit flat key over a coincidental nesting', () => {
    const cfg = {
      'agentTaskPlayer.git.autoCommit': true,
      agentTaskPlayer: { git: { autoCommit: false } },
    };
    assert.strictEqual(readSetting(cfg, 'agentTaskPlayer', 'git.autoCommit', false), true);
  });
});
