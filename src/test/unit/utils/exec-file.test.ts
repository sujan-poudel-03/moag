// ─── Security: execFileAsync never reaches a shell ───

import { strict as assert } from 'assert';
import * as sinon from 'sinon';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

type ExecCb = (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void;

interface Call { cmd: string; args: string[]; opts: Record<string, unknown>; cb: ExecCb; }

function load() {
  const calls: Call[] = [];
  const fakeChild = { pid: 4242, killed: false };
  const execSync = sinon.stub();
  const spawn = sinon.stub();
  const killProcess = sinon.spy();
  const mod = proxyquire('../../../utils/exec-file', {
    child_process: {
      execFile: (cmd: string, args: string[], opts: Record<string, unknown>, cb: ExecCb) => {
        calls.push({ cmd, args, opts, cb });
        return fakeChild;
      },
      execSync,
      spawn,
    },
    './process-kill': { killProcess },
  });
  return { mod, calls, killProcess, fakeChild, execSync };
}

describe('execFileAsync', () => {
  afterEach(() => sinon.restore());

  it('forces shell:false even when the caller passes shell:true', async () => {
    const { mod, calls } = load();
    const p = mod.execFileAsync('git', ['status'], { shell: true, cwd: '/w' } as unknown as Record<string, unknown>);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.cwd, '/w');
    assert.equal('timeoutMs' in calls[0].opts, false, 'wrapper-only options are not forwarded');
    assert.equal('signal' in calls[0].opts, false);
    calls[0].cb(null, 'ok', '');
    const r = await p;
    assert.deepEqual(r, { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
  });

  it('passes a shell-metacharacter argument through as one literal element', async () => {
    const { mod, calls } = load();
    const evil = '; rm -rf / && $(id)';
    const p = mod.execFileAsync('git', ['clone', '--', evil, 'dest']);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].args, ['clone', '--', evil, 'dest']);
    assert.ok(calls[0].args.includes(evil));
    calls[0].cb(null, '', '');
    await p;
  });

  it('resolves (never rejects) on a non-zero exit', async () => {
    const { mod, calls } = load();
    const p = mod.execFileAsync('git', ['x']);
    const err = Object.assign(new Error('exit 128'), { code: 128 });
    calls[0].cb(err, '', 'fatal: nope');
    const r = await p;
    assert.equal(r.exitCode, 128);
    assert.equal(r.stderr, 'fatal: nope');
    assert.equal(r.timedOut, false);
  });

  it('rejects when the binary cannot be spawned (ENOENT)', async () => {
    const { mod, calls } = load();
    const p = mod.execFileAsync('nope', []);
    calls[0].cb(Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }), '', '');
    await assert.rejects(p, /ENOENT/);
  });

  it('removes the abort listener on the close path', async () => {
    const { mod, calls, killProcess } = load();
    const ac = new AbortController();
    const removeSpy = sinon.spy(ac.signal, 'removeEventListener');
    const p = mod.execFileAsync('git', ['x'], { signal: ac.signal });
    calls[0].cb(null, '', '');
    await p;
    assert.equal(removeSpy.calledWith('abort'), true);
    ac.abort();
    assert.equal(killProcess.called, false, 'a stale listener would kill a finished child');
  });

  it('removes the abort listener on the error path', async () => {
    const { mod, calls, killProcess } = load();
    const ac = new AbortController();
    const removeSpy = sinon.spy(ac.signal, 'removeEventListener');
    const p = mod.execFileAsync('nope', [], { signal: ac.signal });
    calls[0].cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', '');
    await assert.rejects(p);
    assert.equal(removeSpy.calledWith('abort'), true);
    ac.abort();
    assert.equal(killProcess.called, false);
  });

  it('kills the tree on abort mid-run and resolves with exitCode null', async () => {
    const { mod, calls, killProcess, fakeChild } = load();
    const ac = new AbortController();
    const p = mod.execFileAsync('git', ['clone'], { signal: ac.signal });
    ac.abort();
    assert.equal(killProcess.calledOnceWith(fakeChild), true);
    calls[0].cb(Object.assign(new Error('killed'), { code: null, signal: 'SIGTERM' }), 'partial', '');
    const r = await p;
    assert.equal(r.exitCode, null);
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout, 'partial');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const { mod, calls } = load();
    const ac = new AbortController();
    ac.abort();
    const r = await mod.execFileAsync('git', ['x'], { signal: ac.signal });
    assert.equal(calls.length, 0);
    assert.equal(r.exitCode, null);
  });

  it('kills the tree on timeout, reports timedOut, and clears the timer', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const { mod, calls, killProcess } = load();
      const p = mod.execFileAsync('git', ['clone'], { timeoutMs: 1000 });
      clock.tick(999);
      assert.equal(killProcess.called, false);
      clock.tick(1);
      assert.equal(killProcess.calledOnce, true);
      calls[0].cb(Object.assign(new Error('killed'), { code: null, signal: 'SIGTERM' }), '', '');
      const r = await p;
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, null);
      assert.equal(clock.countTimers(), 0, 'no timer left armed');
    } finally {
      clock.restore();
    }
  });

  it('clears the timeout timer when the process finishes first', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const { mod, calls, killProcess } = load();
      const p = mod.execFileAsync('git', ['x'], { timeoutMs: 1000 });
      calls[0].cb(null, '', '');
      await p;
      assert.equal(clock.countTimers(), 0);
      clock.tick(5000);
      assert.equal(killProcess.called, false);
    } finally {
      clock.restore();
    }
  });
});
