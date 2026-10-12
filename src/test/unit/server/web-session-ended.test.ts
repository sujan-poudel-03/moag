// ─── Web app: changing your own roles signs you out with a reason, not "no permission" ───
//
// The server ends every session of a user whose roles, disabled flag or password an admin
// changes — the admin's own included. The users screen used to refresh the session, find
// it gone, and re-render itself as C21 ("You don't have permission to do that…"). The pure
// mapping is lifted out of the browser module and run in a VM, as web-standards.test does.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'web', 'js');

/** A web module with its imports removed and its exports made plain, run with `stubs` in scope. */
function loadWebModule(file: string, stubs: Record<string, unknown>, expose: string[]): Record<string, unknown> {
  const source = fs.readFileSync(path.join(WEB, file), 'utf-8')
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(async\s+)?function\s/gm, '$1function ')
    .replace(/^export\s+const\s/gm, 'const ');
  const context: Record<string, unknown> = { ...stubs };
  vm.runInNewContext(`${source}\n${expose.map((name) => `this[${JSON.stringify(name)}] = ${name};`).join('\n')}`, context);
  return context;
}

const never = (): never => { throw new Error('a DOM helper was called by a pure function'); };

type Notice = (resp: unknown, body: unknown, isSelf: boolean) => string | null;

describe('web users screen — your own role change ends your session with a reason', () => {
  const strings = loadWebModule('strings.js', {}, ['STR']);
  const STR = strings.STR as Record<string, { text: string }>;
  const users = loadWebModule(path.join('screens', 'admin-users.js'), {
    h: never, mount: never, badge: never, toast: never, confirmDialog: never, openModal: never, field: never,
    skeleton: never, errorCard: never, uid: never, serverMessage: never, STR,
  }, ['ownSessionEndedNotice']);
  const notice = users.ownSessionEndedNotice as Notice;
  const ok = (body: Record<string, unknown> = {}) => ({ ok: true, status: 200, body: { user: {}, ...body } });

  it('the copy says what happened and what to do', () => {
    assert.equal(STR.C61.text, 'Your roles changed, so you were signed out. Sign in again.');
    assert.match(STR.C62.text, /signed out\. Sign in again\.$/);
    assert.notEqual(STR.C61.text, STR.C21.text);
  });

  it('a session the server reports ended maps to the sign-in notice, never to C21', () => {
    assert.equal(notice(ok({ sessionEnded: true }), { roles: ['reviewer'] }, true), STR.C61.text);
    assert.equal(notice(ok({ sessionEnded: true }), { password: 'x' }, true), STR.C62.text);
    assert.equal(notice(ok({ sessionEnded: true }), { disabled: true }, true), STR.C62.text);
  });

  it('a change to your own account counts as session-ended even when the server did not flag it', () => {
    assert.equal(notice(ok(), { roles: ['reviewer'] }, true), STR.C61.text);
  });

  it('someone else\'s change, or a failed request, leaves the session alone', () => {
    assert.equal(notice(ok(), { roles: ['reviewer'] }, false), null);
    assert.equal(notice({ ok: false, status: 403, body: { error: 'forbidden' } }, { roles: ['reviewer'] }, true), null);
    assert.equal(notice({ ok: false, status: 401, body: { error: 'unauthenticated' } }, { roles: ['reviewer'] }, true), null);
    assert.equal(notice({ ok: false, status: 409, body: { error: 'last-admin' } }, { roles: ['reviewer'] }, true), null);
    assert.equal(notice(null, {}, true), null);
  });

  it('the screen signs out on that notice, and the sign-in page shows it once', () => {
    const screen = fs.readFileSync(path.join(WEB, 'screens', 'admin-users.js'), 'utf-8');
    assert.match(screen, /const ended = ownSessionEndedNotice\(resp, body, u\.id === app\.session\.user\.id\);\s*if \(ended\) \{ await app\.endSession\(ended\); return true; \}/);
    const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf-8');
    assert.match(app, /^\s+endSession,$/m, 'the app exposes endSession to screens');
    assert.match(app, /async function endSession\(notice\) \{[\s\S]*?app\.notice = notice \|\| null;[\s\S]*?navigate\('\/login', \{ replace: true \}\);/);
    const login = fs.readFileSync(path.join(WEB, 'screens', 'login.js'), 'utf-8');
    assert.match(login, /const notice = app\.notice;\s*app\.notice = null;/, 'shown once');
    assert.match(login, /notice \? h\('div', \{ class: \['card', 'card-info'\], role: 'status' \}, h\('p', null, notice\)\) : null/);
  });
});
