// ─── Browser driver tests — failure paths first ───
// Locks in the removal of the lazy `npx --yes playwright` install fallback:
// with no local binary the driver must give up IMMEDIATELY and never spawn.

// Import a local TS module first so ts-node/register resolves this file as CommonJS.
import { detectProject } from '../../../sandbox/project-detector';
void detectProject;

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-bdrv-'));
}

/** Create node_modules/.bin/playwright[.cmd] and return the path. */
function makeLocalBin(cwd: string, name: string): string {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, name);
  fs.writeFileSync(bin, 'echo playwright');
  return bin;
}

function makeFakeSpawnProc(exitCode: number, writeFile?: string): EventEmitter {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { /* no-op */ };
  setImmediate(() => {
    if (writeFile) {
      fs.writeFileSync(writeFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    }
    proc.emit('exit', exitCode);
  });
  return proc;
}

function loadDriver(spawnStub: sinon.SinonStub, execSyncStub?: sinon.SinonStub):
typeof import('../../../sandbox/browser-driver') {
  return proxyquire('../../../sandbox/browser-driver', {
    child_process: {
      spawn: spawnStub,
      // The Windows kill path uses execSync — stub it too or the suite can hang.
      execSync: execSyncStub ?? sinon.stub(),
    },
  });
}

describe('browser-driver — resolveBrowserRunner', () => {
  afterEach(() => sinon.restore());

  it('reports unprovisioned with a hint and never spawns when no local binary exists', () => {
    const spawnStub = sinon.stub();
    const { resolveBrowserRunner } = loadDriver(spawnStub);

    const runner = resolveBrowserRunner(tmpCwd());
    assert.equal(runner.kind, 'unprovisioned');
    assert.match(
      runner.kind === 'unprovisioned' ? runner.reason : '',
      /Provision Browsers/,
    );
    assert.ok(spawnStub.notCalled, 'probing must never spawn a process');
  });

  it('finds a local playwright binary', () => {
    const cwd = tmpCwd();
    const bin = makeLocalBin(cwd, 'playwright');
    const { resolveBrowserRunner } = loadDriver(sinon.stub());

    const runner = resolveBrowserRunner(cwd);
    assert.equal(runner.kind, 'local');
    assert.equal(runner.kind === 'local' ? runner.bin : null, bin);
  });

  it('finds playwright.cmd when only the Windows shim exists', () => {
    const cwd = tmpCwd();
    const bin = makeLocalBin(cwd, 'playwright.cmd');
    const { resolveBrowserRunner } = loadDriver(sinon.stub());

    const runner = resolveBrowserRunner(cwd);
    assert.equal(runner.kind, 'local');
    assert.equal(runner.kind === 'local' ? runner.bin : null, bin);
  });
});

describe('browser-driver — capturePageScreenshot', () => {
  afterEach(() => sinon.restore());

  it('resolves null immediately and never spawns when unprovisioned', async () => {
    const spawnStub = sinon.stub();
    const { capturePageScreenshotBase64 } = loadDriver(spawnStub);

    const startedAt = Date.now();
    const result = await capturePageScreenshotBase64('http://localhost:3000', tmpCwd());
    const elapsed = Date.now() - startedAt;

    assert.equal(result, null);
    assert.ok(spawnStub.notCalled, 'unprovisioned must not spawn');
    assert.ok(elapsed < 2000, `must not wait for the 30s timeout (took ${elapsed}ms)`);
  });

  it('reports the unprovisioned reason via the detailed variant', async () => {
    const { capturePageScreenshotDetailed } = loadDriver(sinon.stub());
    const detailed = await capturePageScreenshotDetailed('http://localhost:3000', tmpCwd());
    assert.equal(detailed.base64, null);
    assert.match(detailed.reason, /not installed in this workspace/);
  });

  it('spawns the local binary and never passes --yes anywhere in argv', async () => {
    const cwd = tmpCwd();
    const bin = makeLocalBin(cwd, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');

    let argv: string[] = [];
    const spawnStub = sinon.stub().callsFake((cmd: string, args: string[]) => {
      argv = [cmd, ...args];
      return makeFakeSpawnProc(0, args[args.length - 1]);
    });
    const { capturePageScreenshotBase64 } = loadDriver(spawnStub);

    const result = await capturePageScreenshotBase64('http://localhost:3000', cwd);

    assert.ok(result, 'should return base64 data');
    assert.ok(spawnStub.calledOnce);
    assert.equal(argv[0], bin, 'args[0] must be the resolved local binary');
    assert.ok(!argv.includes('--yes'), 'regression lock: --yes must never appear in argv');
    assert.ok(!argv.includes('npx'), 'regression lock: npx must never be spawned');
  });

  it('returns null when the local binary exits non-zero', async () => {
    const cwd = tmpCwd();
    makeLocalBin(cwd, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    const spawnStub = sinon.stub().callsFake(() => makeFakeSpawnProc(1));
    const { capturePageScreenshotDetailed } = loadDriver(spawnStub);

    const detailed = await capturePageScreenshotDetailed('http://localhost:3000', cwd);
    assert.equal(detailed.base64, null);
    assert.match(detailed.reason, /failed/);
  });

  it('returns null when the spawn errors', async () => {
    const cwd = tmpCwd();
    makeLocalBin(cwd, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    const spawnStub = sinon.stub().callsFake(() => {
      const proc = new EventEmitter() as EventEmitter & { kill: () => void };
      proc.kill = () => { /* no-op */ };
      setImmediate(() => proc.emit('error', new Error('ENOENT')));
      return proc;
    });
    const { capturePageScreenshotBase64 } = loadDriver(spawnStub);

    assert.equal(await capturePageScreenshotBase64('http://localhost:3000', cwd), null);
  });
});

describe('browser-driver — runPlaywrightSpec', () => {
  afterEach(() => sinon.restore());

  it('returns the provisioning hint and never spawns when unprovisioned', async () => {
    const spawnStub = sinon.stub();
    const { runPlaywrightSpec } = loadDriver(spawnStub);

    const out = await runPlaywrightSpec('e2e/login.spec.ts', tmpCwd());
    assert.match(out, /Provision Browsers/);
    assert.ok(spawnStub.notCalled, 'unprovisioned must not spawn');
  });

  it('spawns the local binary with no --yes in argv', async () => {
    const cwd = tmpCwd();
    const bin = makeLocalBin(cwd, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    let argv: string[] = [];
    const spawnStub = sinon.stub().callsFake((cmd: string, args: string[]) => {
      argv = [cmd, ...args];
      return makeFakeSpawnProc(0);
    });
    const { runPlaywrightSpec } = loadDriver(spawnStub);

    const out = await runPlaywrightSpec('e2e/login.spec.ts', cwd);
    assert.equal(out, '(all tests passed)');
    assert.equal(argv[0], bin);
    assert.ok(!argv.includes('--yes'), 'regression lock: --yes must never appear in argv');
  });

  it('surfaces a non-zero exit code', async () => {
    const cwd = tmpCwd();
    makeLocalBin(cwd, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    const spawnStub = sinon.stub().callsFake(() => makeFakeSpawnProc(3));
    const { runPlaywrightSpec } = loadDriver(spawnStub);

    const out = await runPlaywrightSpec('e2e/login.spec.ts', cwd);
    assert.match(out, /\[exit 3\]/);
  });
});
