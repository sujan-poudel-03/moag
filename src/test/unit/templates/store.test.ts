import { strict as assert } from 'assert';
import { EngineId } from '../../../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { TemplateStore } = proxyquire('../../../templates/store', {
  vscode: vscodeMock,
});

// Use EngineId to avoid unused-import lint warning
const _engineCheck: EngineId = 'claude';
void _engineCheck;

interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  engine?: string;
  category: string;
}

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

describe('TemplateStore', () => {
  it('should include built-in templates', () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    const all = store.getAll() as TaskTemplate[];
    assert.ok(all.length >= 10, `Expected at least 10 built-in templates, got ${all.length}`);
    assert.ok(all.some((t: TaskTemplate) => t.id.startsWith('builtin-')));
  });

  it('should return empty user templates initially', () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    assert.deepEqual(store.getUserTemplates(), []);
  });

  it('should add a user template', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    await store.add({ id: 'user-1', name: 'My Template', prompt: 'Do X', category: 'Custom' });
    const user = store.getUserTemplates() as TaskTemplate[];
    assert.equal(user.length, 1);
    assert.equal(user[0].name, 'My Template');
  });

  it('should include user templates in getAll', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    const countBefore = (store.getAll() as TaskTemplate[]).length;
    await store.add({ id: 'user-2', name: 'Custom', prompt: 'test', category: 'Custom' });
    assert.equal((store.getAll() as TaskTemplate[]).length, countBefore + 1);
  });

  it('should remove a user template by ID', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    await store.add({ id: 'rm-1', name: 'Remove Me', prompt: 'test', category: 'Custom' });
    await store.remove('rm-1');
    assert.equal((store.getUserTemplates() as TaskTemplate[]).length, 0);
  });

  it('should clear all user templates', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    await store.add({ id: 'c-1', name: 'A', prompt: 'a', category: 'X' });
    await store.add({ id: 'c-2', name: 'B', prompt: 'b', category: 'Y' });
    await store.clear();
    assert.deepEqual(store.getUserTemplates(), []);
  });

  it('should return unique categories', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    const categories = store.getCategories() as string[];
    assert.ok(categories.length > 0);
    // Should be sorted and unique
    const sorted = [...categories].sort();
    assert.deepEqual(categories, sorted);
    assert.equal(categories.length, new Set(categories).size);
  });

  it('should emit change events on add', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    let fired = false;
    store.onDidChange(() => { fired = true; });
    await store.add({ id: 'ev-1', name: 'Test', prompt: 'test', category: 'A' });
    assert.ok(fired);
  });

  it('should emit change events on remove', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    await store.add({ id: 'ev-2', name: 'Test', prompt: 'test', category: 'A' });
    let fired = false;
    store.onDidChange(() => { fired = true; });
    await store.remove('ev-2');
    assert.ok(fired);
  });

  it('should not remove built-in templates', async () => {
    const memento = createMemento();
    const store = new TemplateStore(memento);
    const countBefore = (store.getAll() as TaskTemplate[]).length;
    await store.remove('builtin-setup-project');
    // Built-in templates are not stored in user templates, so remove is a no-op
    assert.equal((store.getAll() as TaskTemplate[]).length, countBefore);
  });
});