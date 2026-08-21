import { strict as assert } from 'assert';
import { EngineId, Plan } from '../../../models/types';
import { dehydratePlan, hydratePlan } from '../../../models/plan';

// Use import to avoid unused-import lint warning
const _engineCheck: EngineId = 'claude';
void _engineCheck;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const { BUILT_IN_PLAN_TEMPLATES } = proxyquire('../../../templates/built-in-plans', {
  vscode: vscodeMock,
});

interface TaskShape {
  id: string;
  name: string;
  prompt: string;
}

interface PlaylistShape {
  name: string;
  tasks: TaskShape[];
}

interface PlanShape {
  name: string;
  playlists: PlaylistShape[];
}

interface TemplateShape {
  id: string;
  name: string;
  category: string;
  buildPlan(projectName: string): PlanShape;
}

describe('Built-in Plan Templates', () => {
  const templates = BUILT_IN_PLAN_TEMPLATES as TemplateShape[];

  it('should have at least one template', () => {
    assert.ok(templates.length > 0, 'Expected at least one template');
  });

  it('all template IDs should be unique', () => {
    const ids = templates.map(t => t.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, `Duplicate template IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
  });

  it('all categories should be valid', () => {
    const validCategories = ['Scaffold', 'Improve', 'Fix', 'Automate'];
    for (const tpl of templates) {
      assert.ok(validCategories.includes(tpl.category), `Template "${tpl.id}" has invalid category "${tpl.category}". Expected one of: ${validCategories.join(', ')}`);
    }
  });

  it('plan round-trips through dehydrate/hydrate', () => {
    for (const tpl of templates) {
      const original = tpl.buildPlan('RoundTripTest') as Plan;
      // Compared in *file* space, not object space: templates build plans with `createTask`,
      // which emits 5 keys, while `hydrateTask` emits every field of Task. Comparing the
      // runtime objects would fail for that unrelated reason and hide real field loss.
      const once = dehydratePlan(original);
      const twice = dehydratePlan(hydratePlan(once));
      assert.deepEqual(twice, once, `Template "${tpl.id}": fields lost in the dehydrate/hydrate round-trip`);
    }
  });

  it('every template still yields at least one task after the round-trip', () => {
    for (const tpl of templates) {
      const original = tpl.buildPlan('RoundTripTest') as Plan;
      const rehydrated = hydratePlan(dehydratePlan(original));
      const taskCount = rehydrated.playlists.reduce((sum, pl) => sum + pl.tasks.length, 0);
      assert.ok(taskCount >= 1, `Template "${tpl.id}": expected at least 1 task after round-trip, got ${taskCount}`);
    }
  });

  for (const tpl of (BUILT_IN_PLAN_TEMPLATES as TemplateShape[])) {
    describe(`template "${tpl.name}" (${tpl.id})`, () => {
      let builtPlan: PlanShape;

      before(() => {
        builtPlan = tpl.buildPlan('TestProject');
      });

      it('should produce a plan with a non-empty name', () => {
        assert.ok(builtPlan.name && builtPlan.name.trim().length > 0, 'Plan name must be non-empty');
      });

      it('should have at least 1 playlist', () => {
        assert.ok(builtPlan.playlists.length >= 1, 'Plan must have at least 1 playlist');
      });

      it('should have at least 1 task in each playlist', () => {
        for (const pl of builtPlan.playlists) {
          assert.ok(pl.tasks.length >= 1, `Playlist "${pl.name}" must have at least 1 task`);
        }
      });

      it('should have non-empty id, name, and prompt on every task', () => {
        for (const pl of builtPlan.playlists) {
          for (const t of pl.tasks) {
            assert.ok(t.id && t.id.trim().length > 0, `Task in "${pl.name}" must have a non-empty id`);
            assert.ok(t.name && t.name.trim().length > 0, `Task in "${pl.name}" must have a non-empty name`);
            assert.ok(t.prompt && t.prompt.trim().length > 0, `Task in "${pl.name}" must have a non-empty prompt`);
          }
        }
      });
    });
  }
});
