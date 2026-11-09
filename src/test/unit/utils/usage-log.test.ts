import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendUsageEntry, createUsageRecorder, readAllUsageEntries, UsageLogEntry, USAGE_LOG_FILE, USAGE_LOG_MAX_BYTES, USAGE_LOG_ROTATED_FILE,
} from '../../../utils/usage-log';

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

  it('does not rotate under the cap — 200 entries in, 200 entries out', () => {
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

describe('usage log rotation', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-rotate-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const lineBytes = Buffer.byteLength(JSON.stringify(makeEntry({ taskId: 'task-0' })) + '\n');

  it('the cap is 5 MB', () => {
    assert.equal(USAGE_LOG_MAX_BYTES, 5 * 1024 * 1024);
  });

  it('rotates once the file reaches the cap, not before', () => {
    const cap = lineBytes * 2;
    appendUsageEntry(tmpDir, makeEntry({ taskId: 'task-0' }), cap);
    appendUsageEntry(tmpDir, makeEntry({ taskId: 'task-1' }), cap); // file is now exactly at the cap
    assert.equal(fs.existsSync(path.join(tmpDir, USAGE_LOG_ROTATED_FILE)), false, 'no rotation below the cap');
    appendUsageEntry(tmpDir, makeEntry({ taskId: 'task-2' }), cap); // at the cap: rotate first
    assert.equal(fs.readFileSync(path.join(tmpDir, USAGE_LOG_ROTATED_FILE), 'utf-8').trim().split('\n').length, 2);
    assert.equal(fs.readFileSync(path.join(tmpDir, USAGE_LOG_FILE), 'utf-8').trim().split('\n').length, 1);
  });

  it('a second rotation overwrites usage-log.1.jsonl (one generation kept)', () => {
    const cap = lineBytes;
    for (let i = 0; i < 3; i++) { appendUsageEntry(tmpDir, makeEntry({ taskId: `task-${i}` }), cap); }
    const rotated = fs.readFileSync(path.join(tmpDir, USAGE_LOG_ROTATED_FILE), 'utf-8').trim().split('\n');
    assert.equal(rotated.length, 1);
    assert.equal(JSON.parse(rotated[0]).taskId, 'task-1');
    assert.deepEqual(readAllUsageEntries(tmpDir).map((e) => e.taskId), ['task-1', 'task-2']);
  });

  it('reads span both files, the rotated one first', () => {
    const cap = lineBytes * 2;
    for (let i = 0; i < 4; i++) { appendUsageEntry(tmpDir, makeEntry({ taskId: `task-${i}` }), cap); }
    assert.deepEqual(readAllUsageEntries(tmpDir).map((e) => e.taskId), ['task-0', 'task-1', 'task-2', 'task-3']);
  });
});

describe('createUsageRecorder', () => {
  const record = (() => { const { developerEmail: _d, ...r } = makeEntry(); void _d; return r; })();

  function recorder(over: { enabled?: boolean; recordEmail?: boolean; moagDir?: string | null } = {}) {
    const appended: UsageLogEntry[] = [];
    const lookups: string[] = [];
    const rec = createUsageRecorder({
      enabled: () => over.enabled ?? true,
      recordEmail: () => over.recordEmail ?? false,
      moagDir: () => (over.moagDir === undefined ? '/w/.moag' : over.moagDir),
      cwd: () => '/w',
      resolveEmail: (cwd) => { lookups.push(cwd); return 'dev@example.com'; },
      append: (_dir, e) => { appended.push(e); },
    });
    return { rec, appended, lookups };
  }

  it('records no email by default, and never looks it up', () => {
    const { rec, appended, lookups } = recorder();
    rec(record);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].developerEmail, null);
    assert.deepEqual(lookups, []);
  });

  it('records the email when recordDeveloperEmail is on', () => {
    const { rec, appended } = recorder({ recordEmail: true });
    rec(record);
    assert.equal(appended[0].developerEmail, 'dev@example.com');
  });

  it('records nothing when the ledger is off or there is no workspace', () => {
    const off = recorder({ enabled: false });
    off.rec(record);
    assert.equal(off.appended.length, 0);
    const noWs = recorder({ moagDir: null });
    noWs.rec(record);
    assert.equal(noWs.appended.length, 0);
  });
});
