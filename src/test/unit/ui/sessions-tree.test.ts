import { strict as assert } from 'assert';
import { HistoryEntry, TaskStatus } from '../../../models/types';
import { RunSession } from '../../../models/run-session';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { HistoryStore } = proxyquire('../../../history/store', {
  vscode: vscodeMock,
});

const { RunSessionStore } = proxyquire('../../../models/run-session', {
  vscode: vscodeMock,
});

const { SessionsTreeProvider } = proxyquire('../../../ui/sessions-tree', {
  vscode: vscodeMock,
});

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
  };
}

function makeSession(overrides: Partial<RunSession> = {}): RunSession {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    planName: 'Approval Gate Run',
    startedAt: '2026-03-13T10:00:00.000Z',
    finishedAt: '2026-03-13T10:05:00.000Z',
    engines: ['codex'],
    taskCount: 2,
    tasksCompleted: 2,
    tasksFailed: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    status: 'completed',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task-1',
    taskName: 'Schema hydration',
    playlistId: 'playlist-1',
    playlistName: 'Schema',
    engine: 'codex',
    prompt: 'hydrate the approval gate into the plan schema',
    result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, summary: 'Updated schema types.' },
    status: TaskStatus.Completed,
    startedAt: '2026-03-13T10:00:00.000Z',
    finishedAt: '2026-03-13T10:00:01.000Z',
    ...overrides,
  };
}

describe('SessionsTreeProvider search', () => {
  function createProvider() {
    const historyStore = new HistoryStore(createMemento());
    const runSessionStore = new RunSessionStore(createMemento());
    const provider = new SessionsTreeProvider(historyStore, runSessionStore);
    return { historyStore, runSessionStore, provider };
  }

  it('matches sessions by run history metadata, not only plan name', () => {
    const { historyStore, runSessionStore, provider } = createProvider();

    runSessionStore.create(makeSession({ id: 'run-1', planName: 'Approval Gate Run', engines: ['codex'] }));
    runSessionStore.create(makeSession({ id: 'run-2', planName: 'Unrelated Plan', engines: ['claude'] }));

    historyStore.add(makeEntry({
      runId: 'run-1',
      modelId: 'gpt-5.4',
      taskName: 'Hydrate gate types',
      playlistName: 'Schema work',
    }));

    provider.setFilter('gpt-5.4');

    const roots = provider.getChildren();
    const sessionsGroup = roots.find((item: { kind: string }) => item.kind === 'sessions-group');
    assert.ok(sessionsGroup, 'expected a sessions group');

    const sessionNodes = provider.getChildren(sessionsGroup);
    assert.equal(sessionNodes.length, 1);
    assert.equal(sessionNodes[0].label, 'Approval Gate Run');
  });

  it('matches conversations by prompt text, not only thread title', () => {
    const { historyStore, provider } = createProvider();

    historyStore.add(makeEntry({
      id: 'thread-head',
      threadId: 'thread-1',
      taskName: 'Rollback flow',
      engine: 'claude',
      modelId: 'sonnet-4',
      prompt: 'add checkpoint rollback controls before gated playlists',
    }));

    provider.setFilter('checkpoint');

    const roots = provider.getChildren();
    const conversationsGroup = roots.find((item: { kind: string }) => item.kind === 'conversations-group');
    assert.ok(conversationsGroup, 'expected a conversations group');

    const threadNodes = provider.getChildren(conversationsGroup);
    assert.equal(threadNodes.length, 1);
    assert.equal(threadNodes[0].label, 'Rollback flow');
  });

  it('shows an explicit empty state when a filter has no matches', () => {
    const { historyStore, runSessionStore, provider } = createProvider();

    runSessionStore.create(makeSession({ id: 'run-1' }));
    historyStore.add(makeEntry({ runId: 'run-1' }));

    provider.setFilter('does-not-exist');

    const roots = provider.getChildren();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].label, 'No matching sessions');
  });
});
