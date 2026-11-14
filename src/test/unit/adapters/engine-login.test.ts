// ─── Engine sign-in check ───
//
// An installed engine CLI that is not signed in used to count as "available": ONOSOO offered Start run,
// the machine accepted it, and every run then failed with "Not logged in". The check below turns that
// into a missing engine with a reason. It must fail open: only an explicit "signed out" blocks an engine.

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import {
  checkEngineAvailability,
  registerEngine,
  EngineAdapter,
  EngineRunOptions,
} from '../../../adapters/engine';
import { CLAUDE_SIGNED_OUT_REASON, ClaudeAdapter, parseClaudeAuthStatus } from '../../../adapters/claude-adapter';
import { EngineId, EngineResult } from '../../../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('parseClaudeAuthStatus', () => {
  it('reads signed in, with any method', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'), 'signed-in');
    assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}'), 'signed-in');
  });

  it('reads signed out only when it says so plainly: logged out and no method', () => {
    assert.equal(parseClaudeAuthStatus('{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }'), 'signed-out');
  });

  it('does not guess from anything else', () => {
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false}'), 'unknown');
    assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"api_key"}'), 'unknown');
    assert.equal(parseClaudeAuthStatus('Not logged in. Run claude auth login to authenticate.'), 'unknown');
    assert.equal(parseClaudeAuthStatus('error: unknown command auth'), 'unknown');
    assert.equal(parseClaudeAuthStatus(''), 'unknown');
    assert.equal(parseClaudeAuthStatus('null'), 'unknown');
    assert.equal(parseClaudeAuthStatus('[]'), 'unknown');
  });

  it('the reason is one short sentence', () => {
    assert.ok(CLAUDE_SIGNED_OUT_REASON.length < 160);
    assert.match(CLAUDE_SIGNED_OUT_REASON, /not signed in/i);
    assert.doesNotMatch(CLAUDE_SIGNED_OUT_REASON, /\n/);
  });
});

describe('ClaudeAdapter.checkLogin', () => {
  const KEYS = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; } } });

  it('does not judge when another way of signing in is configured', async () => {
    for (const k of KEYS) {
      process.env[k] = k.startsWith('CLAUDE_CODE_USE_') ? '1' : 'x';
      assert.equal(await new ClaudeAdapter().checkLogin(), null, k);
      delete process.env[k];
    }
  });

  it('is unknown, not blocked, when the command cannot be run', async () => {
    const adapter = new ClaudeAdapter();
    adapter.getCommand = () => 'moag-no-such-claude-binary';
    assert.equal(await adapter.checkLogin(), null);
  });
});

describe('probeCommand', () => {
  class FakeProc extends EventEmitter { stdout = new EventEmitter(); stderr = new EventEmitter(); pid = 7; }
  function load(behave: (p: FakeProc) => void) {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const mod = proxyquire('../../../adapters/base-cli', {
      child_process: {
        spawn: (command: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ command, args, env: opts.env });
          const proc = new FakeProc();
          setImmediate(() => behave(proc));
          return proc;
        },
        execSync: () => '',
      },
      '../utils/process-kill': { killProcess: () => undefined, SPAWN_DETACHED: false },
      '../utils/child-tracker': { trackChildProcess: () => undefined },
    });
    return { mod: mod as typeof import('../../../adapters/base-cli'), calls };
  }

  it('returns the exit code AND the output when the command exits non-zero', async () => {
    const { mod, calls } = load((p) => { p.stdout.emit('data', Buffer.from('{"loggedIn":false,"authMethod":"none"}\n')); p.emit('close', 1); });
    const r = await mod.probeCommand('claude', ['auth', 'status']);
    assert.deepEqual(r, { code: 1, output: '{"loggedIn":false,"authMethod":"none"}' });
    assert.deepEqual(calls[0].args, ['auth', 'status']);
  });

  it('falls back to stderr when stdout is empty, and is null when it cannot start', async () => {
    const { mod } = load((p) => { p.stderr.emit('data', Buffer.from('only on stderr')); p.emit('close', 0); });
    assert.deepEqual(await mod.probeCommand('x', []), { code: 0, output: 'only on stderr' });
    const broken = load((p) => p.emit('error', new Error('ENOENT')));
    assert.equal(await broken.mod.probeCommand('x', []), null);
  });

  it('probeVersion still treats a non-zero exit as no version', async () => {
    const { mod } = load((p) => { p.stdout.emit('data', Buffer.from('2.0.0\n')); p.emit('close', 2); });
    assert.equal(await mod.probeVersion('claude'), null);
  });
});

describe('checkEngineAvailability with a sign-in check', () => {
  function stub(id: EngineId, login: EngineAdapter['checkLogin']): EngineAdapter {
    return {
      id,
      displayName: `Stub ${id}`,
      getCommand: () => 'node', // exists wherever the tests run
      async runTask(_o: EngineRunOptions): Promise<EngineResult> { return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; },
      ...(login ? { checkLogin: login } : {}),
    };
  }

  it('marks an installed but signed-out engine unavailable, with the reason', async () => {
    registerEngine(stub('custom', async () => ({ ok: false, reason: 'Not signed in.' })));
    const a = (await checkEngineAvailability(['custom'])).get('custom')!;
    assert.equal(a.available, false);
    assert.equal(a.reason, 'Not signed in.');
    assert.ok(a.version, 'the version is still reported');
  });

  it('keeps an engine available when the check cannot tell, or fails', async () => {
    registerEngine(stub('custom', async () => null));
    assert.equal((await checkEngineAvailability(['custom'])).get('custom')!.available, true);
    registerEngine(stub('custom', async () => { throw new Error('boom'); }));
    const a = (await checkEngineAvailability(['custom'])).get('custom')!;
    assert.equal(a.available, true);
    assert.equal(a.reason, undefined);
  });

  it('an engine with no sign-in check behaves as before', async () => {
    registerEngine(stub('custom', undefined));
    const a = (await checkEngineAvailability(['custom'])).get('custom')!;
    assert.equal(a.available, true);
    assert.equal(a.reason, undefined);
  });
});
