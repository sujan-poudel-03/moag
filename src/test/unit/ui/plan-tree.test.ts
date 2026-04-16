import { strict as assert } from 'assert';
import { Plan, TaskStatus } from '../../../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { PlanTreeProvider } = proxyquire('../../../ui/plan-tree', {
  vscode: vscodeMock,
});

describe('PlanTreeProvider', () => {
  it('shows playlist progress and concise task metadata', () => {
    const provider = new PlanTreeProvider();
    const longPrompt = `Line one\n\nLine two ${'x'.repeat(120)}`;
    const cleanedPrompt = longPrompt.replace(/\s+/g, ' ').trim();

    const plan: Plan = {
      version: '1.0',
      name: 'UX Redesign',
      description: 'This should not appear in the plan tree rows.',
      defaultEngine: 'gemini',
      validation: {
        targets: ['all'],
        profile: 'quick',
        contextBudget: { discoveryTokens: 12000, analysisTokens: 24000, fixTokens: 16000 },
      },
      playlists: [
        {
          id: 'playlist-1',
          name: 'Phase 1',
          engine: 'claude',
          autoplay: true,
          tasks: [
            {
              id: 'task-1',
              name: 'Simplify sidebar layout',
              prompt: 'Clean the sidebar hierarchy.',
              status: TaskStatus.Completed,
            },
            {
              id: 'task-2',
              name: 'Handle retry path',
              prompt: 'Recover the failed task path.',
              engine: 'codex',
              status: TaskStatus.Failed,
            },
            {
              id: 'task-3',
              name: 'Tooltip preview task',
              prompt: longPrompt,
              status: TaskStatus.Pending,
            },
          ],
        },
      ],
    };

    provider.setPlan(plan);

    const playlists = provider.getChildren();
    assert.equal(playlists.length, 1);
    assert.equal(playlists[0].label, 'Phase 1');
    assert.equal(playlists[0].description, '1/3 tasks');
    assert.equal(playlists[0].tooltip, 'Phase 1\n\n1/3 tasks');
    assert.equal((playlists[0].iconPath as { id: string }).id, 'folder');

    const tasks = provider.getChildren(playlists[0]);
    assert.equal(tasks.length, 3);

    assert.equal(tasks[0].description, 'Claude | done');
    assert.equal((tasks[0].iconPath as { id: string }).id, 'check');

    assert.equal(tasks[1].description, 'Codex | failed');
    assert.equal((tasks[1].iconPath as { id: string }).id, 'close');

    assert.equal(tasks[2].description, 'Claude | pending');
    assert.equal((tasks[2].iconPath as { id: string }).id, 'circle-outline');
    assert.equal(tasks[2].tooltip, `Tooltip preview task\n\n${cleanedPrompt.substring(0, 100)}...`);
  });

  it('uses running icons for active playlists and tasks', () => {
    const provider = new PlanTreeProvider();
    const plan: Plan = {
      version: '1.0',
      name: 'Execution',
      defaultEngine: 'claude',
      validation: {
        targets: ['all'],
        profile: 'quick',
        contextBudget: { discoveryTokens: 12000, analysisTokens: 24000, fixTokens: 16000 },
      },
      playlists: [
        {
          id: 'playlist-1',
          name: 'Phase 2',
          autoplay: true,
          tasks: [
            {
              id: 'task-1',
              name: 'Stream output',
              prompt: 'Run the task.',
              status: TaskStatus.Running,
            },
          ],
        },
      ],
    };

    provider.setPlan(plan);

    const playlist = provider.getChildren()[0];
    const task = provider.getChildren(playlist)[0];

    assert.equal((playlist.iconPath as { id: string }).id, 'folder-opened');
    assert.equal((task.iconPath as { id: string }).id, 'loading~spin');
    assert.equal(task.description, 'Claude | running');
  });
});
