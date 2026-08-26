// ─── Sandbox manager tests ───
// Covers lifecycle, URL detection from dev-server output, and error handling.

// Import a local TS module first so ts-node/register resolves this file
// through CommonJS instead of Node's native ESM loader.
import type { SandboxState } from '../../../sandbox/sandbox-manager';
// The real (un-proxied) module — the port probe must talk to real sockets.
import { isPortOpen } from '../../../sandbox/sandbox-manager';
import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';
import { detectProject } from '../../../sandbox/project-detector';
void detectProject;
void ({} as SandboxState);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: sinon.SinonStub;
  pid: number;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 12345;
  return proc;
}

/**
 * POSIX group signals, recorded rather than sent.
 *
 * `killProcess` signals the process GROUP on POSIX — `process.kill(-pid)` — and
 * proxyquire cannot stub a global. Against a test double's fake pid that would
 * be a REAL signal to whatever group happens to own 12345 on this machine, so
 * `process.kill` is swapped for the lifetime of this file.
 */
const groupSignals: Array<{ pid: number; signal: string }> = [];
/** Pids whose group signal should fail, so the POSIX path can be made to throw. */
const groupKillFailsFor = new Set<number>();
let realProcessKill: typeof process.kill;

before(() => {
  realProcessKill = process.kill;
  (process as unknown as { kill: unknown }).kill = (pid: number, signal: string) => {
    groupSignals.push({ pid, signal });
    if (groupKillFailsFor.has(Math.abs(pid))) {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
    return true;
  };
});

after(() => {
  (process as unknown as { kill: unknown }).kill = realProcessKill;
});

beforeEach(() => {
  groupSignals.length = 0;
  groupKillFailsFor.clear();
});

/**
 * Assert `proc` was tree-killed, whichever platform the suite runs on.
 *
 * win32 goes through `taskkill /T /F`. POSIX signals the process GROUP — a bare
 * SIGTERM to the child would reach the shell and orphan the dev server under it,
 * which is the whole bug this asserts against.
 */
function assertTreeKilled(proc: FakeProc, execSyncStub: sinon.SinonStub, label: string): void {
  if (process.platform === 'win32') {
    const call = execSyncStub.getCalls().find((c) => String(c.args[0]).includes(String(proc.pid)));
    assert.ok(call, `${label}: expected a taskkill for pid ${proc.pid}`);
    const cmd = String(call!.args[0]);
    assert.match(cmd, /taskkill/i, `${label}: must use taskkill`);
    assert.ok(cmd.includes('/T'), `${label}: must pass /T so the tree dies, not just the shell`);
    assert.ok(cmd.includes('/F'), `${label}: must pass /F`);
  } else {
    const signalled = groupSignals.find((s) => s.pid === -proc.pid);
    assert.ok(signalled,
      `${label}: expected the process GROUP (-${proc.pid}) to be signalled, not just the child`);
    assert.equal(signalled!.signal, 'SIGTERM', `${label}: must SIGTERM`);
  }
}

function makeTempProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-sandbox-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/**
 * Load the manager with `child_process` stubbed everywhere it matters.
 *
 * `utils/process-kill` is proxied too because `stop()` tree-kills through it: on
 * win32 that is a real `execSync('taskkill …')`, which must never fire against
 * the fake pid of a test double.
 */
function loadManager(
  spawnStub: sinon.SinonStub,
  execSyncStub: sinon.SinonStub = sinon.stub(),
): typeof import('../../../sandbox/sandbox-manager') {
  const processKill = proxyquire('../../../utils/process-kill', {
    child_process: { execSync: execSyncStub },
  });
  return proxyquire('../../../sandbox/sandbox-manager', {
    '../utils/process-kill': processKill,
    child_process: { spawn: spawnStub, ChildProcess: class {} },
    net: {
      createConnection: () => {
        const sock = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number) => void;
          destroy: () => void;
        };
        sock.setTimeout = () => undefined;
        sock.destroy = () => undefined;
        // Never connect — simulate closed port
        setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
        return sock;
      },
    },
  });
}

describe('SandboxManager', () => {
  afterEach(() => sinon.restore());

  it('starts in stopped state', () => {
    const spawnStub = sinon.stub();
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    assert.equal(mgr.state.status, 'stopped');
    assert.equal(mgr.state.url, null);
    assert.equal(mgr.state.projectInfo, null);
  });

  it('goes to error state when project type is unknown', async () => {
    const spawnStub = sinon.stub();
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({ 'README.md': 'empty project' });

    await mgr.launch(root);
    assert.equal(mgr.state.status, 'error');
    assert.ok(mgr.state.error?.includes('Could not detect'));
    assert.equal(spawnStub.callCount, 0);
  });

  it('spawns dev command for detected web project and transitions to running on URL match', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({
        dependencies: { next: '14.0.0' },
        scripts: { dev: 'next dev' },
      }),
    });

    const stateSpy = sinon.spy();
    mgr.on('state-changed', stateSpy);

    await mgr.launch(root);

    assert.equal(mgr.state.status, 'starting');
    assert.equal(mgr.state.projectInfo?.framework, 'Next.js');
    assert.equal(spawnStub.callCount, 1);

    // Simulate dev-server output with localhost URL
    fakeProc.stdout.emit('data', Buffer.from('ready - started server on http://localhost:3000\n'));

    assert.equal(mgr.state.status, 'running');
    assert.equal(mgr.state.url, 'http://localhost:3000');
  });

  it('detects Vite-style Local: URL pattern', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ devDependencies: { vite: '5.0.0' }, scripts: { dev: 'vite' } }),
    });

    await mgr.launch(root);
    fakeProc.stdout.emit('data', Buffer.from('  ➜  Local:   http://localhost:5173/\n'));

    assert.equal(mgr.state.status, 'running');
    assert.ok(mgr.state.url?.includes('5173'));
  });

  it('stop() kills the running process and returns to stopped state', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const execSyncStub = sinon.stub();
    const { SandboxManager } = loadManager(spawnStub, execSyncStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    await mgr.launch(root);
    fakeProc.stdout.emit('data', Buffer.from('http://localhost:3000\n'));
    assert.equal(mgr.state.status, 'running');

    mgr.stop();
    assertTreeKilled(fakeProc, execSyncStub, 'primary');
    assert.equal(mgr.state.status, 'stopped');
    assert.equal(mgr.state.url, null);
  });

  it('transitions to stopped on process exit with code 0', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    await mgr.launch(root);
    fakeProc.emit('exit', 0);

    assert.equal(mgr.state.status, 'stopped');
    assert.equal(mgr.state.error, null);
  });

  it('includes error message when process exits non-zero', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    await mgr.launch(root);
    fakeProc.emit('exit', 127);

    assert.equal(mgr.state.status, 'error');
    assert.ok(mgr.state.error?.includes('127'));
  });

  it('emits output events for dev server stdout/stderr', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    const outputs: string[] = [];
    mgr.on('output', (text: string) => outputs.push(text));

    await mgr.launch(root);
    fakeProc.stdout.emit('data', Buffer.from('compiling...\n'));
    fakeProc.stderr.emit('data', Buffer.from('warning\n'));

    assert.ok(outputs.some(o => o.includes('compiling')));
    assert.ok(outputs.some(o => o.includes('warning')));
  });

  it('ignores duplicate launches while already running', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    await mgr.launch(root);
    await mgr.launch(root);

    assert.equal(spawnStub.callCount, 1);
  });

  it('setLastScreenshotPath updates state and emits change', async () => {
    const spawnStub = sinon.stub();
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();

    const stateSpy = sinon.spy();
    mgr.on('state-changed', stateSpy);

    mgr.setLastScreenshotPath('/tmp/shot.png');
    assert.equal(mgr.state.lastScreenshotPath, '/tmp/shot.png');
    assert.ok(stateSpy.calledOnce);
  });

  it('launches with sandbox.command override instead of project auto-detection', async () => {
    const fakeProc = makeFakeProc();
    const spawnStub = sinon.stub().returns(fakeProc);
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({ 'README.md': 'no package' });

    await mgr.launch(root, { command: 'npm run dev', port: 3200 });

    assert.equal(spawnStub.callCount, 1);
    assert.equal(mgr.state.projectInfo?.framework, 'Custom');
    assert.equal(mgr.state.projectInfo?.defaultPort, 3200);
    const [cmd, args] = spawnStub.firstCall.args as [string, string[]];
    assert.equal(cmd, 'npm');
    assert.deepEqual(args, ['run', 'dev']);
  });

  it('launches sandbox.targets and stop() kills both primary and background processes', async () => {
    const primaryProc = makeFakeProc();
    const bgProc = makeFakeProc();
    bgProc.pid = 54321; // distinct pid so the taskkill assertions cannot alias
    const spawnStub = sinon.stub();
    spawnStub.onCall(0).returns(bgProc);      // background target(s) launched first
    spawnStub.onCall(1).returns(primaryProc); // primary web target

    const execSyncStub = sinon.stub();
    const { SandboxManager } = loadManager(spawnStub, execSyncStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({ 'README.md': 'monorepo style test' });

    await mgr.launch(root, {
      targets: [
        { name: 'Frontend', cwd: 'apps/web', command: 'npm run web:dev', port: 3001 },
        { name: 'API', cwd: 'apps/api', command: 'npm run api:dev', port: 4100 },
      ],
    });

    assert.equal(spawnStub.callCount, 2);
    assert.equal(mgr.state.projectInfo?.framework, 'Frontend');

    // Verify per-target cwd resolution
    const bgOpts = spawnStub.firstCall.args[2] as { cwd: string };
    const primaryOpts = spawnStub.secondCall.args[2] as { cwd: string };
    assert.equal(bgOpts.cwd, path.join(root, 'apps', 'api'));
    assert.equal(primaryOpts.cwd, path.join(root, 'apps', 'web'));

    mgr.stop();
    assertTreeKilled(primaryProc, execSyncStub, 'primary');
    assertTreeKilled(bgProc, execSyncStub, 'background');
  });
});

describe('SandboxManager — stop() tree-kill', () => {
  afterEach(() => sinon.restore());

  it('does not throw when there is nothing running', () => {
    const { SandboxManager } = loadManager(sinon.stub());
    const mgr = new SandboxManager();
    assert.doesNotThrow(() => mgr.stop());
    assert.equal(mgr.state.status, 'stopped');
  });

  it('kills every background process even when one kill throws', async () => {
    const primary = makeFakeProc();
    const bgA = makeFakeProc();
    const bgB = makeFakeProc();
    bgA.pid = 22222;
    bgB.pid = 33333;
    bgA.kill.throws(new Error('EPERM'));

    const spawnStub = sinon.stub();
    spawnStub.onCall(0).returns(bgA);
    spawnStub.onCall(1).returns(bgB);
    spawnStub.onCall(2).returns(primary);

    const execSyncStub = sinon.stub();
    // One kill fails; the loop must still reach the rest. Made to fail on BOTH
    // paths — taskkill on win32, the group signal on POSIX — so the scenario is
    // genuinely exercised wherever the suite runs, not just on Windows.
    execSyncStub.withArgs(sinon.match(/22222/)).throws(new Error('EPERM'));
    groupKillFailsFor.add(22222);

    const { SandboxManager } = loadManager(spawnStub, execSyncStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({ 'README.md': 'targets' });

    await mgr.launch(root, {
      targets: [
        { name: 'Web', cwd: '.', command: 'npm run dev', port: 3000 },
        { name: 'A', cwd: '.', command: 'npm run a', port: 4000 },
        { name: 'B', cwd: '.', command: 'npm run b', port: 5000 },
      ],
    });

    assert.doesNotThrow(() => mgr.stop());
    assertTreeKilled(primary, execSyncStub, 'primary');
    assertTreeKilled(bgB, execSyncStub, 'surviving background target');
    assert.equal(mgr.state.status, 'stopped');
  });
});

describe('isPortOpen', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) {
      try { s.close(); } catch { /* ignore */ }
    }
  });

  it('resolves false for a closed port without hanging', async function () {
    this.timeout(8000);
    let open: boolean;
    try {
      open = await isPortOpen(1, '127.0.0.1', 1000);
    } catch (err) {
      if (err instanceof Error && /EPERM/i.test(err.message)) { this.skip(); return; }
      throw err;
    }
    assert.equal(open, false);
  });

  it('resolves true for a port that is actually listening', async function () {
    this.timeout(8000);
    const server = net.createServer();
    servers.push(server);
    let port: number;
    try {
      port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') { resolve(addr.port); } else { reject(new Error('no address')); }
        });
      });
    } catch (err) {
      if (err instanceof Error && /EPERM|EACCES/i.test(err.message)) { this.skip(); return; }
      throw err;
    }
    assert.equal(await isPortOpen(port, '127.0.0.1', 1500), true);
  });

  it('resolves false for an unreachable host via the timeout branch', async function () {
    this.timeout(8000);
    // TEST-NET-1 (RFC 5737) — routable nowhere, so the connect stalls and the
    // timeout branch must resolve false rather than surfacing an unhandled error.
    const open = await isPortOpen(80, '192.0.2.1', 600);
    assert.equal(open, false);
  });
});
