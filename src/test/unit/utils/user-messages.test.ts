import { strict as assert } from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

const UserMsg = proxyquire('../../../utils/user-messages', { vscode: vscodeMock });

describe('UserMsg.planLoadError', () => {
  it('names the file and offers Open File with a Uri argument when a path is given', () => {
    const msg = UserMsg.planLoadError('Unexpected token } in JSON', 'C:\\w\\.moag\\plan.json');
    assert.match(msg.text, /plan\.json/);
    assert.ok(!msg.text.includes('C:\\w'), 'the text names the basename, not the whole path');
    assert.equal(msg.actions?.length, 1);
    const action = msg.actions[0];
    assert.equal(action.label, 'Open File');
    assert.equal(action.command, 'vscode.open');
    assert.ok(action.args[0] instanceof vscodeMock.Uri, 'Open File must pass a Uri, not a string');
    assert.equal(action.args[0].fsPath, 'C:\\w\\.moag\\plan.json');
  });

  it('has no action without a path', () => {
    const msg = UserMsg.planLoadError('bad json');
    assert.equal(msg.actions, undefined);
    assert.match(msg.text, /bad json/);
  });

  it('caps the detail at 150 characters, ellipsis included', () => {
    const detail = 'x'.repeat(400);
    const msg = UserMsg.planLoadError(detail, '/w/.moag/plan.json');
    const shown = msg.text.slice(msg.text.indexOf('x'));
    assert.ok(shown.length <= 150, `detail shown is ${shown.length} characters`);
    assert.ok(shown.endsWith('...'));
  });

  it('works with neither detail nor path', () => {
    const msg = UserMsg.planLoadError();
    assert.equal(msg.text, 'Could not read the plan file.');
  });
});

describe('UserMsg — ONOSOO project ID', () => {
  const KEY = 'git:github.com/o/r';

  it('noOnosooFolder offers Open Folder', () => {
    const msg = UserMsg.noOnosooFolder();
    assert.equal(msg.text, 'Open a folder to get its ONOSOO project ID.');
    assert.deepEqual(msg.actions, [{ label: 'Open Folder', command: 'vscode.openFolder' }]);
  });

  it('onosooProjectIdCopied with a URL, without one, and for a folder other than the first', () => {
    assert.equal(UserMsg.onosooProjectIdCopied(KEY, 'https://github.com/o/r').text,
      'Copied ONOSOO project ID git:github.com/o/r (repository: https://github.com/o/r). Paste it into Add repository in ONOSOO (Builds → Projects).');
    assert.equal(UserMsg.onosooProjectIdCopied(KEY).text,
      'Copied ONOSOO project ID git:github.com/o/r. Paste it into Add repository in ONOSOO (Builds → Projects).');
    assert.equal(UserMsg.onosooProjectIdCopied(KEY, undefined, 'app').text,
      'Copied ONOSOO project ID git:github.com/o/r. Paste it into Add repository in ONOSOO (Builds → Projects). Runs started in VS Code report the first folder, app, not this one.');
    assert.equal(UserMsg.onosooProjectIdCopied(KEY).actions, undefined, 'no actions on success');
  });

  it('onosooProjectIdNotSent takes no key and names none', () => {
    assert.equal(UserMsg.onosooProjectIdNotSent.length, 0);
    const msg = UserMsg.onosooProjectIdNotSent();
    assert.equal(msg.text, "Nothing copied: this folder's ONOSOO project ID would not be sent to ONOSOO, because MOAG's privacy filter would change it. Runs from this folder report no project.");
    assert.equal(msg.actions, undefined);
  });

  it('onosooProjectIdAbsent carries the reason phrase', () => {
    const msg = UserMsg.onosooProjectIdAbsent('no usable origin remote and no commits yet');
    assert.equal(msg.text, 'Nothing copied: this folder has no ONOSOO project ID — no usable origin remote and no commits yet.');
    assert.equal(msg.actions, undefined);
  });

  it('onosooProjectIdTimeout offers Try Again on the copy command', () => {
    const msg = UserMsg.onosooProjectIdTimeout();
    assert.equal(msg.text, 'Nothing copied: the ONOSOO project ID could not be resolved in time.');
    assert.deepEqual(msg.actions, [{ label: 'Try Again', command: 'agentTaskPlayer.copyOnosooProjectId' }]);
  });
});
