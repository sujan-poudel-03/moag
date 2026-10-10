import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeLeftovers, findLiveLeftovers } from '../../../bench/leftovers';

// ─── Leftover workers in a reused --out (isAlive injected; no real processes) ───

describe('bench leftovers', () => {
  let out: string;
  beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-leftovers-')); });
  afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

  const lock = (projectId: string, content: string): void => {
    const dir = path.join(out, 'server-data', 'projects', projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.lock'), content);
  };

  it('reports only the live pids of a lock', () => {
    lock('p1', JSON.stringify({ serverPid: 10, workerPid: 20, taskPids: [30, 31] }));
    assert.deepEqual(findLiveLeftovers(out, (pid) => pid === 20 || pid === 31), [
      { projectId: 'p1', serverPid: null, workerPid: 20, taskPids: [31] },
    ]);
  });

  it('is empty when every holder is dead', () => {
    lock('p1', JSON.stringify({ serverPid: 10, workerPid: 20, taskPids: [30] }));
    assert.deepEqual(findLiveLeftovers(out, () => false), []);
  });

  it('skips a garbage lock, and a project dir without one', () => {
    lock('p1', '{nope');
    fs.mkdirSync(path.join(out, 'server-data', 'projects', 'p2'), { recursive: true });
    lock('p3', JSON.stringify({ workerPid: 20 }));
    assert.deepEqual(findLiveLeftovers(out, () => true), [{ projectId: 'p3', serverPid: null, workerPid: 20, taskPids: [] }]);
  });

  it('is empty when there is no server data', () => {
    assert.deepEqual(findLiveLeftovers(out, () => true), []);
    assert.deepEqual(findLiveLeftovers(path.join(out, 'missing'), () => true), []);
  });

  it('never lists this process', () => {
    lock('p1', JSON.stringify({ serverPid: process.pid, workerPid: 20 }));
    assert.deepEqual(findLiveLeftovers(out, () => true), [{ projectId: 'p1', serverPid: null, workerPid: 20, taskPids: [] }]);
  });

  it('a throwing isAlive counts as dead', () => {
    lock('p1', JSON.stringify({ workerPid: 20 }));
    assert.deepEqual(findLiveLeftovers(out, () => { throw new Error('no'); }), []);
  });

  it('the default isAlive treats a pid with no process as dead', () => {
    lock('p1', JSON.stringify({ workerPid: 2147483646 }));
    assert.deepEqual(findLiveLeftovers(out), []);
  });

  describe('describeLeftovers', () => {
    const leftovers = [{ projectId: 'p1', serverPid: 5, workerPid: 20, taskPids: [31] }];

    it('lists each project and the Windows kill commands', () => {
      const text = describeLeftovers('/o', leftovers, 'win32');
      assert.match(text, /project p1: server 5; worker 20; task 31/);
      assert.match(text, /may still be spending/);
      for (const p of [20, 31, 5]) { assert.ok(text.includes(`taskkill /T /F /PID ${p}`), String(p)); }
      assert.match(text, /Nothing was started/);
    });

    it('gives group-then-process kills on POSIX', () => {
      const text = describeLeftovers('/o', leftovers, 'linux');
      assert.ok(text.includes('kill -TERM -20; kill -TERM 20'));
      assert.doesNotMatch(text, /taskkill/);
    });
  });
});
