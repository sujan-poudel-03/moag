// ─── Sandbox manager tests ───
// Covers lifecycle, URL detection from dev-server output, and error handling.

// Import a local TS module first so ts-node/register resolves this file
// through CommonJS instead of Node's native ESM loader.
import type { SandboxState } from '../../../sandbox/sandbox-manager';
import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
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

function makeTempProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-sandbox-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function loadManager(spawnStub: sinon.SinonStub): typeof import('../../../sandbox/sandbox-manager') {
  return proxyquire('../../../sandbox/sandbox-manager', {
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
    const { SandboxManager } = loadManager(spawnStub);
    const mgr = new SandboxManager();
    const root = makeTempProject({
      'package.json': JSON.stringify({ dependencies: { next: '14.0.0' } }),
    });

    await mgr.launch(root);
    fakeProc.stdout.emit('data', Buffer.from('http://localhost:3000\n'));
    assert.equal(mgr.state.status, 'running');

    mgr.stop();
    assert.ok(fakeProc.kill.calledOnce);
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

    assert.equal(mgr.state.status, 'stopped');
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
});
