import { strict as assert } from 'assert';
import { RunSession } from '../../../models/run-session';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { RunSessionStore } = proxyquire('../../../models/run-session', {
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

function makeSession(overrides: Partial<RunSession> = {}): RunSession {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    planName: 'Test Plan',
    startedAt: new Date().toISOString(),
    engines: ['claude'],
    taskCount: 5,
    tasksCompleted: 0,
    tasksFailed: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    status: 'running',
    ...overrides,
  };
}

describe('RunSessionStore', () => {
  let store: InstanceType<typeof RunSessionStore>;

  beforeEach(() => {
    store = new RunSessionStore(createMemento());
  });

  it('should start empty', () => {
    assert.deepEqual(store.getAll(), []);
  });

  it('should create and retrieve a session', () => {
    const session = makeSession({ id: 'sess-1', planName: 'My Plan' });
    store.create(session);

    const retrieved = store.get('sess-1');
    assert.ok(retrieved);
    assert.equal(retrieved!.planName, 'My Plan');
    assert.equal(retrieved!.status, 'running');
  });

  it('should return all sessions newest first', () => {
    store.create(makeSession({ id: 'a', startedAt: '2026-01-01T00:00:00Z', planName: 'First' }));
    store.create(makeSession({ id: 'b', startedAt: '2026-01-02T00:00:00Z', planName: 'Second' }));
    store.create(makeSession({ id: 'c', startedAt: '2026-01-03T00:00:00Z', planName: 'Third' }));

    const all = store.getAll();
    assert.equal(all.length, 3);
    assert.equal(all[0].planName, 'Third');
    assert.equal(all[2].planName, 'First');
  });

  it('should update a session partially', () => {
    store.create(makeSession({ id: 'sess-1', tasksCompleted: 0, status: 'running' }));
    store.update('sess-1', { tasksCompleted: 3, status: 'completed' });

    const updated = store.get('sess-1');
    assert.ok(updated);
    assert.equal(updated!.tasksCompleted, 3);
    assert.equal(updated!.status, 'completed');
    assert.equal(updated!.taskCount, 5);
  });

  it('should not throw when updating non-existent session', () => {
    store.update('nonexistent', { status: 'completed' });
    assert.equal(store.get('nonexistent'), undefined);
  });

  it('should delete a session', () => {
    store.create(makeSession({ id: 'to-delete' }));
    assert.ok(store.get('to-delete'));

    store.delete('to-delete');
    assert.equal(store.get('to-delete'), undefined);
    assert.equal(store.getAll().length, 0);
  });

  it('should clear all sessions', () => {
    store.create(makeSession({ id: 'a' }));
    store.create(makeSession({ id: 'b' }));
    store.create(makeSession({ id: 'c' }));
    assert.equal(store.getAll().length, 3);

    store.clear();
    assert.equal(store.getAll().length, 0);
  });

  it('should trim to max 50 sessions', () => {
    for (let i = 0; i < 55; i++) {
      store.create(makeSession({ id: `sess-${i}` }));
    }
    assert.equal(store.getAll().length, 50);
    assert.equal(store.get('sess-0'), undefined);
    assert.equal(store.get('sess-1'), undefined);
    assert.ok(store.get('sess-5'));
  });

  it('should fire onDidChange on create', (done) => {
    store.onDidChange(() => done());
    store.create(makeSession());
  });

  it('should fire onDidChange on update', (done) => {
    store.create(makeSession({ id: 'sess-x' }));
    store.onDidChange(() => done());
    store.update('sess-x', { status: 'completed' });
  });

  it('should fire onDidChange on delete', (done) => {
    store.create(makeSession({ id: 'sess-y' }));
    store.onDidChange(() => done());
    store.delete('sess-y');
  });

  it('should persist across instances', () => {
    const memento = createMemento();
    const store1 = new RunSessionStore(memento);
    store1.create(makeSession({ id: 'persistent', planName: 'Persistent Plan' }));

    const store2 = new RunSessionStore(memento);
    const retrieved = store2.get('persistent');
    assert.ok(retrieved);
    assert.equal(retrieved!.planName, 'Persistent Plan');
  });

  it('should track token usage and cost', () => {
    store.create(makeSession({ id: 's1', totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }));
    store.update('s1', {
      totalTokensIn: 1500,
      totalTokensOut: 800,
      totalCost: 0.0234,
    });

    const session = store.get('s1')!;
    assert.equal(session.totalTokensIn, 1500);
    assert.equal(session.totalTokensOut, 800);
    assert.equal(session.totalCost, 0.0234);
  });

  it('should track multiple engines', () => {
    store.create(makeSession({ id: 's2', engines: ['claude', 'codex', 'gemini'] }));
    const session = store.get('s2')!;
    assert.deepEqual(session.engines, ['claude', 'codex', 'gemini']);
  });
});
