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
