import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServerSettingsStore, DEFAULT_SERVER_SETTINGS } from '../../../server/server-settings';

describe('ServerSettingsStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-settings-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('defaults to planner file access OFF with no file', () => {
    assert.deepEqual(new ServerSettingsStore(dir).get(), { allowPlannerFileAccess: false });
    assert.equal(DEFAULT_SERVER_SETTINGS.allowPlannerFileAccess, false);
  });

  it('persists an update across instances and reports before/after', () => {
    const s = new ServerSettingsStore(dir);
    assert.deepEqual(s.update({ allowPlannerFileAccess: true }), {
      before: { allowPlannerFileAccess: false }, after: { allowPlannerFileAccess: true },
    });
    assert.deepEqual(new ServerSettingsStore(dir).get(), { allowPlannerFileAccess: true });
    assert.deepEqual(s.update({}).after, { allowPlannerFileAccess: true }, 'an empty patch changes nothing');
  });

  it('a malformed or non-boolean file reads as the safe defaults, never as permissive', () => {
    const file = path.join(dir, 'server-settings.json');
    for (const raw of ['{not json', '[]', 'null', '{"allowPlannerFileAccess":"true"}', '{"allowPlannerFileAccess":1}']) {
      fs.writeFileSync(file, raw);
      assert.deepEqual(new ServerSettingsStore(dir).get(), { allowPlannerFileAccess: false }, raw);
    }
  });
});
