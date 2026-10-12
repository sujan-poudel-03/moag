import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFileSync, writeFileSync, fileExists, resolvePath, writeFileAtomicSync } from '../../../utils/file-io';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('file-io', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-fileio-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readFileSync', () => {
    it('should read an existing file', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');
      assert.equal(readFileSync(filePath), 'hello world');
    });

    it('should return null for a non-existent file', () => {
      assert.equal(readFileSync(path.join(tmpDir, 'nope.txt')), null);
    });
  });

  describe('writeFileSync', () => {
    it('should write a file', () => {
      const filePath = path.join(tmpDir, 'out.txt');
      writeFileSync(filePath, 'content');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'content');
    });

    it('should create parent directories as needed', () => {
      const filePath = path.join(tmpDir, 'a', 'b', 'c.txt');
      writeFileSync(filePath, 'deep');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'deep');
    });
  });

  describe('fileExists', () => {
    it('should return true for an existing file', () => {
      const filePath = path.join(tmpDir, 'exists.txt');
      fs.writeFileSync(filePath, '', 'utf-8');
      assert.equal(fileExists(filePath), true);
    });

    it('should return false for a missing file', () => {
      assert.equal(fileExists(path.join(tmpDir, 'missing.txt')), false);
    });
  });

  describe('resolvePath', () => {
    it('should join relative path to base', () => {
      const result = resolvePath('/base/dir', 'sub/file.ts');
      assert.equal(result, path.join('/base/dir', 'sub/file.ts'));
    });

    it('should return absolute path as-is', () => {
      const abs = path.resolve('/absolute/path');
      const result = resolvePath('/base', abs);
      assert.equal(result, abs);
    });
  });

  describe('writeFileAtomicSync', () => {
    function errWith(code: string): NodeJS.ErrnoException {
      const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
      e.code = code;
      return e;
    }

    /** The `fs` members file-io uses, with selected members overridden. */
    function fsWith(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        mkdirSync: fs.mkdirSync,
        writeFileSync: fs.writeFileSync,
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
        renameSync: fs.renameSync,
        rmSync: fs.rmSync,
        ...overrides,
      };
    }

    it('writes content, creates parent directories, leaves no temp file', () => {
      const filePath = path.join(tmpDir, 'x', 'y', 'atomic.json');
      writeFileAtomicSync(filePath, '{"a":1}');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), '{"a":1}');
      assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['atomic.json']);
    });

    it('replaces an existing file', () => {
      const filePath = path.join(tmpDir, 'r.txt');
      fs.writeFileSync(filePath, 'old');
      writeFileAtomicSync(filePath, 'new');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'new');
    });

    it('leaves the original untouched and no .tmp behind when rename fails', () => {
      const filePath = path.join(tmpDir, 'orig.txt');
      fs.writeFileSync(filePath, 'original');
      let renameCalls = 0;
      const failingFs = fsWith({ renameSync: () => { renameCalls++; throw errWith('EXDEV'); } });
      const mod = proxyquire('../../../utils/file-io', { fs: failingFs });
      assert.throws(() => mod.writeFileAtomicSync(filePath, 'replacement'), /EXDEV/);
      assert.equal(renameCalls, 1, 'non-retryable codes are not retried');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'original');
      assert.deepEqual(fs.readdirSync(tmpDir), ['orig.txt']);
    });

    it('retries EPERM renames on win32 then rethrows without leaving a .tmp', function () {
      if (process.platform !== 'win32') { this.skip(); }
      const filePath = path.join(tmpDir, 'busy.txt');
      let renameCalls = 0;
      const failingFs = fsWith({ renameSync: () => { renameCalls++; throw errWith('EPERM'); } });
      const mod = proxyquire('../../../utils/file-io', { fs: failingFs });
      assert.throws(() => mod.writeFileAtomicSync(filePath, 'x'), /EPERM/);
      assert.equal(renameCalls, 4, '1 attempt + 3 retries');
      assert.deepEqual(fs.readdirSync(tmpDir), []);
    });

    it('succeeds on win32 when a transient EBUSY clears', function () {
      if (process.platform !== 'win32') { this.skip(); }
      const filePath = path.join(tmpDir, 'flaky.txt');
      let renameCalls = 0;
      const flakyFs = fsWith({
        renameSync: (a: string, b: string) => {
          renameCalls++;
          if (renameCalls === 1) { throw errWith('EBUSY'); }
          fs.renameSync(a, b);
        },
      });
      const mod = proxyquire('../../../utils/file-io', { fs: flakyFs });
      mod.writeFileAtomicSync(filePath, 'ok');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), 'ok');
      assert.equal(renameCalls, 2);
    });

    it('creates the file with mode 0600 by default', function () {
      if (process.platform === 'win32') { this.skip(); }
      const filePath = path.join(tmpDir, 'secret.json');
      writeFileAtomicSync(filePath, '{}');
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    });
  });
});
