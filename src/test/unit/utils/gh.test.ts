// ─── Security regression: gh CLI command-injection prevention ───
//
// MOAG routes untrusted GitHub content (owner/repo/label/body) through the `gh`
// CLI. These tests pin the safe contract: every argument is passed as a discrete
// array element with shell:false, so values like `x`touch HACKED`` can never
// reach a shell. If someone reintroduces string-interpolated execSync(`gh ...`),
// these tests fail.

import { strict as assert } from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

interface Captured { args: string[]; opts: Record<string, unknown>; }

function loadGh(onSync: (c: Captured) => void, onFile: (c: Captured) => void) {
  return proxyquire('../../../utils/gh', {
    child_process: {
      execFileSync: (_cmd: string, args: string[], opts: Record<string, unknown>) => {
        onSync({ args, opts });
        return '';
      },
      execFile: (_cmd: string, args: string[], opts: Record<string, unknown>, cb: (e: Error | null) => void) => {
        onFile({ args, opts });
        cb(null);
      },
    },
  });
}

const MALICIOUS = 'x`touch HACKED`; rm -rf /';

describe('Security: gh CLI safe invocation', () => {
  it('ghSync passes malicious args literally with shell:false', () => {
    let captured: Captured | null = null;
    const { ghSync } = loadGh((c) => { captured = c; }, () => {});

    ghSync(['issue', 'view', '1', '--repo', MALICIOUS, '--json', 'title,body']);

    assert.ok(captured, 'execFileSync should be invoked');
    const c = captured as Captured;
    assert.equal(c.opts.shell, false, 'shell must be false');
    assert.ok(c.args.includes(MALICIOUS), 'malicious value must be a literal array arg, never concatenated into a command string');
    // No element should be a single concatenated shell command line.
    assert.ok(!c.args.some((a) => a.startsWith('gh ')), 'no array element should be a full gh command string');
  });

  it('ghAsync passes malicious label literally with shell:false', () => {
    let captured: Captured | null = null;
    const { ghAsync } = loadGh(() => {}, (c) => { captured = c; });

    ghAsync(['issue', 'edit', '7', '--repo', 'owner/repo', '--add-label', MALICIOUS]);

    assert.ok(captured, 'execFile should be invoked');
    const c = captured as Captured;
    assert.equal(c.opts.shell, false, 'shell must be false');
    assert.ok(c.args.includes(MALICIOUS), 'malicious label must be a literal array arg');
  });

  it('the gh binary name is fixed (not user-controlled)', () => {
    let cmd = '';
    const mod = proxyquire('../../../utils/gh', {
      child_process: {
        execFileSync: (c: string) => { cmd = c; return ''; },
        execFile: () => {},
      },
    });
    mod.ghSync(['--version']);
    assert.equal(cmd, 'gh');
  });
});
