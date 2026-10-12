import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as tracker from '../../../utils/child-tracker';
import { onChildProcess, trackChildProcess, ChildProcessChange } from '../../../utils/child-tracker';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

class FakeChild extends EventEmitter { constructor(public pid?: number) { super(); } }

describe('child-tracker', () => {
  let disposers: Array<() => void> = [];
  afterEach(() => { for (const d of disposers) { d(); } disposers = []; });
  const listen = (): ChildProcessChange[] => {
    const seen: ChildProcessChange[] = [];
    disposers.push(onChildProcess((c) => seen.push(c)));
    return seen;
  };

  it('with no subscriber, attaches nothing to the child', () => {
    const c = new FakeChild(10);
    trackChildProcess(c);
    assert.equal(c.listenerCount('exit'), 0);
    assert.equal(c.listenerCount('error'), 0);
  });

  it('reports start, then exit, and removes both lifecycle listeners', () => {
    const seen = listen();
    const c = new FakeChild(321);
    trackChildProcess(c);
    assert.deepEqual(seen, [{ pid: 321, alive: true }]);
    c.emit('exit', 0);
    assert.deepEqual(seen, [{ pid: 321, alive: true }, { pid: 321, alive: false }]);
    assert.equal(c.listenerCount('exit'), 0);
    assert.equal(c.listenerCount('error'), 0, 'the error listener is removed when exit fires');
  });

  it('a spawn error ends the child exactly once (error then exit)', () => {
    const seen = listen();
    const c = new FakeChild(5);
    trackChildProcess(c);
    c.emit('error', new Error('spawn ENOENT'));
    c.emit('exit', null);
    assert.deepEqual(seen.map((s) => s.alive), [true, false]);
  });

  it('a child with no pid (failed synchronously) is not reported', () => {
    const seen = listen();
    trackChildProcess(new FakeChild(undefined));
    trackChildProcess(new FakeChild(0));
    trackChildProcess(new FakeChild(-3));
    assert.deepEqual(seen, []);
  });

  it('a throwing listener does not break the spawn site or other listeners', () => {
    disposers.push(onChildProcess(() => { throw new Error('boom'); }));
    const seen = listen();
    assert.doesNotThrow(() => trackChildProcess(new FakeChild(7)));
    assert.deepEqual(seen, [{ pid: 7, alive: true }]);
  });

  it('the disposer unsubscribes', () => {
    const seen: ChildProcessChange[] = [];
    const off = onChildProcess((c) => seen.push(c));
    off();
    trackChildProcess(new FakeChild(8));
    assert.deepEqual(seen, []);
  });

  it('runCli reports the engine CLI pid while it runs and its end when it closes', async () => {
    const seen = listen();
    const child = Object.assign(new FakeChild(4545), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true,
      stdin: { write: () => undefined, end: () => undefined, on: () => undefined },
    });
    const { runCli } = proxyquire('../../../adapters/base-cli', {
      child_process: { spawn: () => child, execSync: () => '' },
      '../utils/child-tracker': tracker,
    });
    const pending = runCli({ command: 'claude', buildArgs: () => [], useStdin: true }, { prompt: 'p', cwd: process.cwd() });
    assert.deepEqual(seen, [{ pid: 4545, alive: true }], 'reported as soon as it is spawned');
    child.emit('exit', 1);
    child.emit('close', 1);
    const r = await pending;
    assert.equal(r.exitCode, 1);
    assert.deepEqual(seen, [{ pid: 4545, alive: true }, { pid: 4545, alive: false }]);
  });
});
