import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionStore, SessionUser, sessionCookie, clearSessionCookie, preAuthCookie, sessionCookieName,
  SESSIONS_FILE, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, safeEqual, hashSid,
} from '../../../server/sessions';

describe('sessions', () => {
  let dir: string;
  let t: number;
  let users: Map<string, SessionUser>;
  const lookup = (id: string) => users.get(id);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-sess-'));
    t = Date.parse('2026-10-04T00:00:00Z');
    users = new Map([['u1', { id: 'u1', sessionEpoch: 1, disabled: false }]]);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const store = () => new SessionStore(dir, { now: () => t });

  it('issues a 32-byte base64url sid and a CSRF token', () => {
    const { sid, csrfToken } = store().create(users.get('u1')!);
    assert.match(sid, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(sid, 'base64url').length, 32);
    assert.equal(Buffer.from(csrfToken, 'base64url').length, 32);
  });

  it('never stores the raw sid, only its hash', () => {
    const { sid } = store().create(users.get('u1')!);
    const raw = fs.readFileSync(path.join(dir, SESSIONS_FILE), 'utf-8');
    assert.equal(raw.includes(sid), false);
    assert.equal(raw.includes(hashSid(sid)), true);
  });

  it('resolves a live session and survives a restart', () => {
    const { sid, csrfToken } = store().create(users.get('u1')!);
    const s = store().get(sid, lookup);
    assert.equal(s?.userId, 'u1');
    assert.equal(s?.csrfToken, csrfToken);
  });

  it('kills the session on an epoch mismatch', () => {
    const st = store();
    const { sid } = st.create(users.get('u1')!);
    users.set('u1', { id: 'u1', sessionEpoch: 2, disabled: false });
    assert.equal(st.get(sid, lookup), null);
    users.set('u1', { id: 'u1', sessionEpoch: 1, disabled: false });
    assert.equal(st.get(sid, lookup), null, 'deleted, not merely rejected');
  });

  it('kills the session for a disabled or deleted user', () => {
    const st = store();
    const a = st.create(users.get('u1')!);
    users.set('u1', { id: 'u1', sessionEpoch: 1, disabled: true });
    assert.equal(st.get(a.sid, lookup), null);
    users.set('u1', { id: 'u1', sessionEpoch: 1, disabled: false });
    const b = st.create(users.get('u1')!);
    users.delete('u1');
    assert.equal(st.get(b.sid, lookup), null);
  });

  it('expires on idle timeout, but activity extends it', () => {
    const st = store();
    const { sid } = st.create(users.get('u1')!);
    t += SESSION_IDLE_MS - 1000;
    assert.ok(st.get(sid, lookup));
    t += SESSION_IDLE_MS - 1000;
    assert.ok(st.get(sid, lookup), 'lastSeen moved forward');
    t += SESSION_IDLE_MS + 1;
    assert.equal(st.get(sid, lookup), null);
  });

  it('expires at the absolute lifetime regardless of activity', () => {
    const st = store();
    const { sid } = st.create(users.get('u1')!);
    const step = SESSION_IDLE_MS / 2;
    while (t + step < Date.parse('2026-10-04T00:00:00Z') + SESSION_ABSOLUTE_MS) {
      t += step;
      assert.ok(st.get(sid, lookup));
    }
    t = Date.parse('2026-10-04T00:00:00Z') + SESSION_ABSOLUTE_MS + 1;
    assert.equal(st.get(sid, lookup), null);
  });

  it('destroy and destroyAllForUser remove sessions', () => {
    users.set('u2', { id: 'u2', sessionEpoch: 1, disabled: false });
    const st = store();
    const a = st.create(users.get('u1')!);
    const b = st.create(users.get('u1')!);
    const c = st.create(users.get('u2')!);
    st.destroy(a.sid);
    assert.equal(st.get(a.sid, lookup), null);
    assert.equal(st.destroyAllForUser('u1'), 1);
    assert.equal(st.get(b.sid, lookup), null);
    assert.ok(st.get(c.sid, lookup));
  });

  it('onRevoke reports the sid hashes ended by destroy, destroyAllForUser and expiry on get', () => {
    users.set('u2', { id: 'u2', sessionEpoch: 1, disabled: false });
    const st = store();
    const seen: string[][] = [];
    const dispose = st.onRevoke((h) => seen.push([...h]));
    st.onRevoke(() => { throw new Error('a broken listener'); });
    const a = st.create(users.get('u1')!);
    const b = st.create(users.get('u1')!);
    const c = st.create(users.get('u2')!);
    st.destroy(a.sid);
    st.destroy(a.sid); // already gone: no second notice
    assert.equal(st.destroyAllForUser('u1'), 1);
    assert.equal(st.destroyAllForUser('nobody'), 0);
    users.set('u2', { id: 'u2', sessionEpoch: 2, disabled: false });
    assert.equal(st.get(c.sid, lookup), null);
    assert.deepEqual(seen, [[hashSid(a.sid)], [hashSid(b.sid)], [hashSid(c.sid)]]);
    dispose();
    const d = st.create(users.get('u1')!);
    st.destroy(d.sid);
    assert.equal(seen.length, 3, 'a disposed listener hears nothing');
  });

  it('isLive checks expiry, user and epoch without extending the session', () => {
    const st = store();
    const { sid } = st.create(users.get('u1')!);
    const key = hashSid(sid);
    assert.equal(st.isLive(key, lookup), true);
    t += SESSION_IDLE_MS - 1000;
    assert.equal(st.isLive(key, lookup), true);
    t += 2000;
    assert.equal(st.isLive(key, lookup), false, 'isLive did not move lastSeen, so the session idled out');
    t -= 2000;
    users.set('u1', { id: 'u1', sessionEpoch: 2, disabled: false });
    assert.equal(st.isLive(key, lookup), false, 'epoch moved on');
    users.set('u1', { id: 'u1', sessionEpoch: 1, disabled: true });
    assert.equal(st.isLive(key, lookup), false, 'disabled');
    assert.equal(st.isLive('no-such-hash', lookup), false);
  });

  it('rejects junk cookie values without throwing', () => {
    const st = store();
    for (const v of [undefined, null, '', 'x'.repeat(500), 42]) {
      assert.equal(st.get(v, lookup), null);
    }
  });

  it('treats a corrupt sessions.json as no sessions', () => {
    fs.writeFileSync(path.join(dir, SESSIONS_FILE), '{oops');
    assert.equal(store().size(), 0);
  });

  describe('cookies', () => {
    it('http: HttpOnly, SameSite=Lax, Path=/, no Secure, no __Host-', () => {
      const c = sessionCookie('abc', false);
      assert.match(c, /^moag_sid=abc;/);
      for (const f of ['HttpOnly', 'SameSite=Lax', 'Path=/']) { assert.ok(c.split('; ').includes(f), f); }
      assert.equal(c.includes('Secure'), false);
      assert.equal(c.includes('__Host-'), false);
    });

    it('https: adds Secure and the __Host- prefix', () => {
      const c = sessionCookie('abc', true);
      assert.match(c, /^__Host-moag_sid=abc;/);
      assert.ok(c.split('; ').includes('Secure'));
      assert.ok(c.split('; ').includes('HttpOnly'));
      assert.ok(c.split('; ').includes('SameSite=Lax'));
      assert.ok(c.split('; ').includes('Path=/'));
      assert.equal(c.includes('Domain='), false, '__Host- forbids Domain');
    });

    it('clear cookie expires immediately with the same name and flags', () => {
      for (const secure of [false, true]) {
        const c = clearSessionCookie(secure);
        assert.ok(c.startsWith(`${sessionCookieName(secure)}=;`));
        assert.ok(c.includes('Max-Age=0'));
        assert.equal(c.includes('Secure'), secure);
      }
    });

    it('pre-auth cookie follows the same flag rules', () => {
      assert.match(preAuthCookie('tok', false), /^moag_pre=tok; HttpOnly; SameSite=Lax; Path=\//);
      const s = preAuthCookie('tok', true);
      assert.match(s, /^__Host-moag_pre=tok;/);
      assert.ok(s.includes('Secure'));
    });
  });

  it('safeEqual compares in constant time and rejects empty/non-strings', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), false);
    assert.equal(safeEqual(undefined, 'x'), false);
  });
});
