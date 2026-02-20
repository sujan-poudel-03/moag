import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFileSync, writeFileSync, fileExists, resolvePath } from '../../../utils/file-io';

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
});
