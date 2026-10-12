import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendUsageEntry, readAllUsageEntries, UsageLogEntry, USAGE_LOG_FILE } from '../../../utils/usage-log';

function makeEntry(over: Partial<UsageLogEntry> = {}): UsageLogEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    taskId: 'task-1',
    taskName: 'Do the thing',
    engine: 'claude-code',
    prompt: 'do the thing',
    tokenUsageAvailable: true,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.01,
    developerEmail: 'dev@example.com',
    ...over,
  };
}

describe('appendUsageEntry / readAllUsageEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends then reads back a round trip', () => {
    const entry = makeEntry({ taskId: 'task-abc' });
    appendUsageEntry(tmpDir, entry);
    const entries = readAllUsageEntries(tmpDir);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], entry);
  });

  it('skips a malformed line but keeps valid ones', () => {
    const logPath = path.join(tmpDir, USAGE_LOG_FILE);
    if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
    const good1 = JSON.stringify(makeEntry({ taskId: 'good-1' }));
    const good2 = JSON.stringify(makeEntry({ taskId: 'good-2' }));
    fs.writeFileSync(logPath, `${good1}\nnot-json-garbage\n${good2}\n`, 'utf-8');
    const entries = readAllUsageEntries(tmpDir);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.taskId), ['good-1', 'good-2']);
  });

  it('survives a restart — a fresh read after writing N entries returns all N', () => {
    for (let i = 0; i < 10; i++) {
      appendUsageEntry(tmpDir, makeEntry({ taskId: `task-${i}` }));
    }
    // Simulate a restart: a brand-new read with no state carried over.
    const entries = readAllUsageEntries(tmpDir);
    assert.equal(entries.length, 10);
    assert.deepEqual(entries.map(e => e.taskId), Array.from({ length: 10 }, (_, i) => `task-${i}`));
  });

  it('creates the .moag directory if it does not exist', () => {
    const nested = path.join(tmpDir, 'new-moag-dir');
    appendUsageEntry(nested, makeEntry());
    assert.ok(fs.existsSync(path.join(nested, USAGE_LOG_FILE)));
  });

  it('does not rotate — 200 entries in, 200 entries out', () => {
    for (let i = 0; i < 200; i++) {
      appendUsageEntry(tmpDir, makeEntry({ taskId: `task-${i}` }));
    }
    const entries = readAllUsageEntries(tmpDir);
    assert.equal(entries.length, 200);
    assert.equal(entries[0].taskId, 'task-0');
    assert.equal(entries[199].taskId, 'task-199');
  });

  it('is best-effort on append — does not throw for an unwritable path', () => {
    assert.doesNotThrow(() => {
      appendUsageEntry('/this/path/cannot/exist/ever', makeEntry());
    });
  });

  it('returns [] for a directory with no usage-log.jsonl', () => {
    assert.deepEqual(readAllUsageEntries(tmpDir), []);
  });

  it('returns [] on a completely unreadable directory', () => {
    assert.deepEqual(readAllUsageEntries('/this/path/does/not/exist'), []);
  });

  it('never stores an assembled-context-sized prompt — only the short human prompt', () => {
    // A regression pin for the HIGH finding: this field must carry the short
    // task prompt, never buildContext()'s assembled output.
    const entry = makeEntry({ prompt: 'Add token refresh handling' });
    appendUsageEntry(tmpDir, entry);
    const [stored] = readAllUsageEntries(tmpDir);
    assert.ok(stored.prompt.length < 200, 'prompt field must hold the short human prompt, not assembled context');
    assert.equal(stored.prompt, 'Add token refresh handling');
  });
});
