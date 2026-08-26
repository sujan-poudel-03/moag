import * as assert from 'assert';
import { ChildProcess } from 'child_process';

/**
 * Killing a child that was spawned through a shell has to reach the whole tree.
 * A bare SIGTERM kills the shell and ORPHANS what it launched — which for a
 * `service` task is a dev server still holding its port, and that is exactly how
 * a browser UAT gate passes green against yesterday's code.
 *
 * Windows had `taskkill /T` from the start. POSIX did not: it got a plain
 * SIGTERM, so the same bug that was fixed on Windows stayed live on macOS and
 * Linux. These tests pin both halves.
 */

/** A stand-in for a spawned process. */
function fakeProc(over: Partial<ChildProcess> = {}): ChildProcess {
  return { pid: 4242, killed: false, kill: () => true, ...over } as unknown as ChildProcess;
}

/** Load process-kill with a chosen platform and a recording `process.kill`. */
function loadOn(platform: string) {
  const groupSignals: Array<{ pid: number; signal: string }> = [];
  const directKills: string[] = [];
  const execCalls: string[] = [];

  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const realKill = process.kill;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  (process as unknown as { kill: unknown }).kill = (pid: number, signal: string) => {
    groupSignals.push({ pid, signal });
    // A child that is not a group leader has no group with its id.
    if (pid < 0 && (loadOn as unknown as { noGroup?: boolean }).noGroup) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }
    return true;
  };

  for (const k of Object.keys(require.cache)) {
    if (k.includes('process-kill')) { delete require.cache[k]; }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyquire = require('proxyquire').noCallThru();
  const mod = proxyquire('../../../utils/process-kill', {
    child_process: {
      execSync: (cmd: string) => { execCalls.push(cmd); },
      ChildProcess: class {},
    },
  });

  return {
    mod,
    groupSignals,
    directKills,
    execCalls,
    restore() {
      Object.defineProperty(process, 'platform', realPlatform);
      (process as unknown as { kill: unknown }).kill = realKill;
    },
  };
}

describe('process-kill — SPAWN_DETACHED', () => {
  it('is false on Windows, where detached means a new console', () => {
    const h = loadOn('win32');
    try { assert.strictEqual(h.mod.SPAWN_DETACHED, false); } finally { h.restore(); }
  });

  it('is true on POSIX, so a child can lead a group worth signalling', () => {
    for (const platform of ['darwin', 'linux']) {
      const h = loadOn(platform);
      try {
        assert.strictEqual(h.mod.SPAWN_DETACHED, true, `${platform} should spawn detached`);
      } finally { h.restore(); }
    }
  });
});

describe('process-kill — killing the tree', () => {
  it('uses taskkill /T on Windows so the whole tree goes', () => {
    const h = loadOn('win32');
    try {
      h.mod.killProcess(fakeProc());
      assert.strictEqual(h.execCalls.length, 1);
      assert.ok(h.execCalls[0].includes('/T'), 'without /T the tree survives');
      assert.ok(h.execCalls[0].includes('4242'));
    } finally { h.restore(); }
  });

  it('signals the process GROUP on POSIX, not just the child', () => {
    const h = loadOn('darwin');
    try {
      h.mod.killProcess(fakeProc());
      // A negative pid addresses the group led by that pid.
      assert.deepStrictEqual(h.groupSignals, [{ pid: -4242, signal: 'SIGTERM' }],
        'a bare SIGTERM would reach the shell and orphan the dev server under it');
      assert.strictEqual(h.execCalls.length, 0, 'taskkill does not exist on POSIX');
    } finally { h.restore(); }
  });

  it('falls back to the direct child when there is no group', () => {
    // A child spawned without `detached` leads no group; the group signal throws
    // ESRCH and must not be the end of the attempt.
    (loadOn as unknown as { noGroup?: boolean }).noGroup = true;
    const h = loadOn('linux');
    let directCalled = false;
    try {
      h.mod.killProcess(fakeProc({ kill: () => { directCalled = true; return true; } }));
      assert.ok(directCalled, 'ESRCH on the group must fall through to killing the child');
    } finally {
      h.restore();
      delete (loadOn as unknown as { noGroup?: boolean }).noGroup;
    }
  });

  it('does nothing to a process that is already dead', () => {
    for (const platform of ['win32', 'darwin']) {
      const h = loadOn(platform);
      try {
        h.mod.killProcess(fakeProc({ killed: true }));
        assert.strictEqual(h.execCalls.length, 0, `${platform}: should not shell out`);
        assert.strictEqual(h.groupSignals.length, 0, `${platform}: should not signal`);
      } finally { h.restore(); }
    }
  });

  it('survives a process with no pid rather than signalling something else', () => {
    // process.kill(-undefined) would be nonsense; the guard matters.
    const h = loadOn('darwin');
    try {
      h.mod.killProcess(fakeProc({ pid: undefined }));
      assert.strictEqual(h.groupSignals.length, 0, 'must not signal without a pid');
    } finally { h.restore(); }
  });
});
