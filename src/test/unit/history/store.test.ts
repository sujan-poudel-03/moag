import { strict as assert } from 'assert';
import { HistoryEntry, TaskStatus } from '../../../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { HistoryStore } = proxyquire('../../../history/store', {
  vscode: vscodeMock,
});

/** Create a mock Memento */
function createMemento(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (key in store ? store[key] : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store[key] = value;
      return Promise.resolve();
    },
    _store: store,
  };
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 6)}`,
    taskId: 'task-1',
    taskName: 'Test Task',
    playlistId: 'pl-1',
    playlistName: 'Test Playlist',
    engine: 'claude',
    prompt: 'do something',
    result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100 },
    status: TaskStatus.Completed,
    startedAt: '2026-02-12T10:00:00.000Z',
    finishedAt: '2026-02-12T10:00:01.000Z',
    ...overrides,
  };
}

describe('HistoryStore', () => {
  it('should start empty when no stored data', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    assert.deepEqual(store.getAll(), []);
  });

  it('should load existing entries from memento', () => {
    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
    const memento = createMemento({ 'agentTaskPlayer.history': entries });
    const store = new HistoryStore(memento);
    const all = store.getAll();
    assert.equal(all.length, 2);
    // getAll returns newest first (reversed)
    assert.equal(all[0].id, 'e2');
    assert.equal(all[1].id, 'e1');
  });

  it('should add an entry', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    const entry = makeEntry({ id: 'new-1' });
    store.add(entry);
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'new-1');
  });

  it('should persist entries to memento on add', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry());
    const persisted = memento._store['agentTaskPlayer.history'] as HistoryEntry[];
    assert.equal(persisted.length, 1);
  });

  it('should clear all entries', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry());
    store.add(makeEntry());
    store.clear();
    assert.deepEqual(store.getAll(), []);
  });

  it('should filter by task id', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry({ taskId: 'a' }));
    store.add(makeEntry({ taskId: 'b' }));
    store.add(makeEntry({ taskId: 'a' }));
    const filtered = store.getForTask('a');
    assert.equal(filtered.length, 2);
    filtered.forEach((e: HistoryEntry) => assert.equal(e.taskId, 'a'));
  });

  it('should filter by playlist id', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry({ playlistId: 'x' }));
    store.add(makeEntry({ playlistId: 'y' }));
    const filtered = store.getForPlaylist('x');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].playlistId, 'x');
  });

  it('should trim to maxHistoryEntries', () => {
    // The mock config returns default 200 for maxHistoryEntries
    const memento = createMemento();
    const store = new HistoryStore(memento);
    // Add 210 entries
    for (let i = 0; i < 210; i++) {
      store.add(makeEntry({ id: `e-${i}` }));
    }
    const all = store.getAll();
    assert.ok(all.length <= 200);
  });

  it('should emit change events on add', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    let fired = false;
    store.onDidChange(() => { fired = true; });
    store.add(makeEntry());
    assert.ok(fired);
  });

  it('should emit change events on clear', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry());
    let fired = false;
    store.onDidChange(() => { fired = true; });
    store.clear();
    assert.ok(fired);
  });

  it('should return entries newest-first from getAll', () => {
    const memento = createMemento();
    const store = new HistoryStore(memento);
    store.add(makeEntry({ id: 'first' }));
    store.add(makeEntry({ id: 'second' }));
    store.add(makeEntry({ id: 'third' }));
    const all = store.getAll();
    assert.equal(all[0].id, 'third');
    assert.equal(all[2].id, 'first');
  });
});
