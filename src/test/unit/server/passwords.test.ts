import { strict as assert } from 'assert';
import * as crypto from 'crypto';
import * as sinon from 'sinon';
import {
  hashPassword, verifyPassword, validatePasswordPolicy, DUMMY_HASH, activeScryptCount, SCRYPT_MAX_CONCURRENCY,
} from '../../../server/passwords';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('passwords', function () {
  this.timeout(20000);

  it('round-trips a password and uses the documented format', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.match(h, /^scrypt\$15\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(h.split('$')[5], 'base64').length, 64);
    assert.equal(Buffer.from(h.split('$')[4], 'base64').length, 16);
    assert.equal(await verifyPassword('correct horse battery staple', h), true);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-123'), hashPassword('same-password-123')]);
    assert.notEqual(a, b);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery stapl', h), false);
    assert.equal(await verifyPassword('', h), false);
  });

  it('returns false without throwing for malformed hashes and inputs', async () => {
    for (const bad of [
      '', 'plaintext', 'scrypt$15$8$1$abc', 'bcrypt$15$8$1$AAAA$BBBB',
      'scrypt$99$8$1$AAECAwQFBgcICQoLDA0ODw==$AAAA', // logN out of range (DoS guard)
      'scrypt$15$8$1$!!!$???', null, undefined, 42, {},
    ]) {
      assert.equal(await verifyPassword('whatever-password', bad), false, `hash ${JSON.stringify(bad)}`);
    }
    assert.equal(await verifyPassword(undefined, DUMMY_HASH), false);
  });

  it('DUMMY_HASH is well-formed and matches nothing obvious', async () => {
    assert.equal(await verifyPassword('', DUMMY_HASH), false);
    assert.equal(await verifyPassword('password', DUMMY_HASH), false);
  });

  it('compares with crypto.timingSafeEqual', async () => {
    const realHash = await hashPassword('timing-safe-check-1');
    const spy = sinon.spy(crypto.timingSafeEqual);
    const fakeCrypto = { scrypt: crypto.scrypt, randomBytes: crypto.randomBytes, timingSafeEqual: spy };
    const mod = proxyquire('../../../server/passwords', { crypto: fakeCrypto });
    assert.equal(await mod.verifyPassword('timing-safe-check-1', realHash), true);
    assert.equal(spy.calledOnce, true);
    assert.equal(await mod.verifyPassword('wrong-password-xx', realHash), false);
    assert.equal(spy.calledTwice, true, 'a mismatch is also decided by timingSafeEqual');
    const [a, b] = spy.firstCall.args as [Buffer, Buffer];
    assert.equal(a.length, b.length);
  });

  it('caps concurrent scrypt computations', async () => {
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, activeScryptCount()); }, 1);
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => hashPassword(`concurrency-${i}-pw`)));
    } finally {
      clearInterval(timer);
    }
    assert.ok(peak <= SCRYPT_MAX_CONCURRENCY, `peak ${peak}`);
    assert.equal(activeScryptCount(), 0, 'all slots released');
  });

  it('enforces the 12-256 character policy', () => {
    assert.match(validatePasswordPolicy('short') ?? '', /at least 12/);
    assert.match(validatePasswordPolicy('x'.repeat(257)) ?? '', /at most 256/);
    assert.equal(validatePasswordPolicy('x'.repeat(12)), null);
    assert.equal(validatePasswordPolicy('x'.repeat(256)), null);
    assert.match(validatePasswordPolicy(undefined) ?? '', /required/);
  });
});
