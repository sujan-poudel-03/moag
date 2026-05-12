// ─── Screenshot capture tests ───
// Mocks child_process to verify tool selection (playwright/adb/xcrun) by project type.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-shot-'));
}

function makeFakeSpawnProc(exitCode: number, writeFile?: string): EventEmitter {
  const proc = new EventEmitter();
  setImmediate(() => {
    if (writeFile) {
      fs.writeFileSync(writeFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    }
    proc.emit('exit', exitCode);
  });
  return proc;
}

function loadScreenshot(mocks: {
  spawnStub?: sinon.SinonStub;
  execSyncStub?: sinon.SinonStub;
}): typeof import('../../../sandbox/screenshot') {
  return proxyquire('../../../sandbox/screenshot', {
    child_process: {
      spawn: mocks.spawnStub ?? sinon.stub(),
      execSync: mocks.execSyncStub ?? sinon.stub(),
    },
  });
}

describe('captureScreenshot', () => {
  afterEach(() => sinon.restore());

  it('returns null when web is selected but no url is provided', async () => {
    const { captureScreenshot } = loadScreenshot({});
    const result = await captureScreenshot({ projectType: 'web', url: null, cwd: tmpCwd() });
    assert.equal(result, null);
  });

  it('invokes playwright for web projects and returns path on success', async () => {
    const cwd = tmpCwd();
    let spawnedArgs: string[] = [];
    let spawnOpts: { cwd?: string } | undefined;
    const spawnStub = sinon.stub().callsFake((cmd: string, args: string[], opts: { cwd?: string }) => {
      spawnedArgs = [cmd, ...args];
      spawnOpts = opts;
      const outputPath = args[args.length - 1];
      return makeFakeSpawnProc(0, outputPath);
    });
    const { captureScreenshot } = loadScreenshot({ spawnStub });

    const result = await captureScreenshot({
      projectType: 'web',
      url: 'http://localhost:3000',
      cwd,
    });

    assert.ok(result, 'should return a path');
    assert.ok(result?.includes('screenshot-'));
    assert.ok(spawnedArgs.some(a => a.includes('playwright')), 'should invoke playwright');
    assert.ok(spawnedArgs.includes('http://localhost:3000'), 'should pass URL to playwright');
    assert.equal(spawnOpts?.cwd, cwd, 'should run playwright from workspace cwd');
    assert.ok(fs.existsSync(result!));
  });

  it('prefers local playwright binary from workspace cwd', async () => {
    const cwd = tmpCwd();
    const binDir = path.join(cwd, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const localBin = path.join(binDir, process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    fs.writeFileSync(localBin, 'echo playwright');

    let spawnedCmd = '';
    const spawnStub = sinon.stub().callsFake((cmd: string, args: string[]) => {
      spawnedCmd = cmd;
      const outputPath = args[args.length - 1];
      return makeFakeSpawnProc(0, outputPath);
    });

    const { captureScreenshot } = loadScreenshot({ spawnStub });
    const result = await captureScreenshot({
      projectType: 'web',
      url: 'http://localhost:3000',
      cwd,
    });

    assert.ok(result, 'should return a path');
    assert.equal(spawnedCmd, localBin, 'should use local playwright binary');
  });

  it('returns null when playwright exits non-zero', async () => {
    const cwd = tmpCwd();
    const spawnStub = sinon.stub().callsFake(() => makeFakeSpawnProc(1));
    const { captureScreenshot } = loadScreenshot({ spawnStub });

    const result = await captureScreenshot({
      projectType: 'web',
      url: 'http://localhost:3000',
      cwd,
    });
    assert.equal(result, null);
  });

  it('falls back to iOS when Android adb fails for mobile projects', async () => {
    const cwd = tmpCwd();
    const execSyncStub = sinon.stub().callsFake((cmd: string) => {
      if (cmd.startsWith('adb')) {
        throw new Error('no device');
      }
      if (cmd.startsWith('xcrun')) {
        // Simulate iOS screenshot by writing to the output path
        const m = cmd.match(/"([^"]+)"/);
        if (m) { fs.writeFileSync(m[1], Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
        return Buffer.from('');
      }
      throw new Error('unexpected cmd: ' + cmd);
    });
    const { captureScreenshot } = loadScreenshot({ execSyncStub });

    const result = await captureScreenshot({ projectType: 'mobile', url: null, cwd });
    assert.ok(result, 'should return a path from iOS fallback');
    assert.ok(result?.endsWith('.png'));
  });

  it('returns null for mobile when neither adb nor xcrun succeed', async () => {
    const cwd = tmpCwd();
    const execSyncStub = sinon.stub().throws(new Error('no tools'));
    const { captureScreenshot } = loadScreenshot({ execSyncStub });

    const result = await captureScreenshot({ projectType: 'mobile', url: null, cwd });
    assert.equal(result, null);
  });

  it('creates .moag/screenshots/ directory if missing', async () => {
    const cwd = tmpCwd();
    const spawnStub = sinon.stub().callsFake((cmd: string, args: string[]) => {
      return makeFakeSpawnProc(0, args[args.length - 1]);
    });
    const { captureScreenshot } = loadScreenshot({ spawnStub });

    await captureScreenshot({ projectType: 'web', url: 'http://localhost:3000', cwd });
    assert.ok(fs.existsSync(path.join(cwd, '.moag', 'screenshots')));
  });

  it('returns null for unknown project types', async () => {
    const { captureScreenshot } = loadScreenshot({});
    const result = await captureScreenshot({
      projectType: 'unknown' as 'web',
      url: null,
      cwd: tmpCwd(),
    });
    assert.equal(result, null);
  });
});
