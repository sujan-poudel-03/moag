import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendErrorLog, readRecentErrors, InternalError } from '../../../utils/error-log';

describe('appendErrorLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates errors.jsonl and writes one entry', () => {
    appendErrorLog(tmpDir, { ts: '2026-01-01T00:00:00', category: 'runner', message: 'spawn failed' });
    const content = fs.readFileSync(path.join(tmpDir, 'errors.jsonl'), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as InternalError;
    assert.equal(parsed.category, 'runner');
    assert.equal(parsed.message, 'spawn failed');
  });

  it('appends multiple entries in chronological order', () => {
    appendErrorLog(tmpDir, { ts: 't1', category: 'kg', message: 'err1' });
    appendErrorLog(tmpDir, { ts: 't2', category: 'github', message: 'err2' });
    const lines = fs.readFileSync(path.join(tmpDir, 'errors.jsonl'), 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]) as InternalError).message, 'err1');
    assert.equal((JSON.parse(lines[1]) as InternalError).message, 'err2');
  });

  it('rotates to keep last 50 entries when over limit', () => {
    for (let i = 0; i < 55; i++) {
      appendErrorLog(tmpDir, { ts: 't', category: 'general', message: `err${i}` });
    }
    const lines = fs.readFileSync(path.join(tmpDir, 'errors.jsonl'), 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 50);
    // Last written entry should be last in the file
    assert.equal((JSON.parse(lines[lines.length - 1]) as InternalError).message, 'err54');
    // First 5 entries (err0..err4) should be rotated out
    assert.equal((JSON.parse(lines[0]) as InternalError).message, 'err5');
  });

  it('creates the directory if it does not exist', () => {
    const nested = path.join(tmpDir, 'new-moag-dir');
    appendErrorLog(nested, { ts: 't', category: 'uncaught', message: 'test' });
    assert.ok(fs.existsSync(path.join(nested, 'errors.jsonl')));
  });

  it('stores optional context and stack fields', () => {
    appendErrorLog(tmpDir, { ts: 't', category: 'kg', message: 'fail',
      context: 'KG rebuild: app.ts', stack: 'Error\n  at x:1' });
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, 'errors.jsonl'), 'utf-8').trim()) as InternalError;
    assert.equal(entry.context, 'KG rebuild: app.ts');
    assert.ok(entry.stack?.includes('at x:1'));
  });

  it('does not throw when moagDir path is unwritable — best-effort', () => {
    // Should never throw — errors are silently swallowed
    assert.doesNotThrow(() => {
      appendErrorLog('/this/path/cannot/exist/ever', { ts: 't', category: 'general', message: 'x' });
    });
  });

  it('calls outputFn when provided', () => {
    const lines: string[] = [];
    appendErrorLog(tmpDir, { ts: 't', category: 'runner', message: 'hello', context: 'ctx' },
      (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('[runner]'));
    assert.ok(lines[0].includes('hello'));
    assert.ok(lines[0].includes('ctx'));
  });
});

describe('readRecentErrors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-log-read-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when file does not exist', () => {
    const result = readRecentErrors(tmpDir);
    assert.deepEqual(result, []);
  });

  it('returns last N entries', () => {
    for (let i = 0; i < 15; i++) {
      appendErrorLog(tmpDir, { ts: `t${i}`, category: 'general', message: `err${i}` });
    }
    const result = readRecentErrors(tmpDir, 5);
    assert.equal(result.length, 5);
    assert.equal(result[result.length - 1].message, 'err14');
    assert.equal(result[0].message, 'err10');
  });

  it('returns all entries when N exceeds total count', () => {
    appendErrorLog(tmpDir, { ts: 't', category: 'runner', message: 'only one' });
    const result = readRecentErrors(tmpDir, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].message, 'only one');
  });

  it('skips malformed JSON lines without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'errors.jsonl'),
      'not-json\n{"ts":"t","category":"runner","message":"ok"}\n', 'utf-8');
    const result = readRecentErrors(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].message, 'ok');
  });

  it('returns empty array on completely unreadable directory', () => {
    const result = readRecentErrors('/this/path/does/not/exist');
    assert.deepEqual(result, []);
  });
});
