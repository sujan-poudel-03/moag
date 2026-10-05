import { strict as assert } from 'assert';
import { LoginRateLimiter } from '../../../server/rate-limit';

describe('LoginRateLimiter', () => {
  let t: number;
  const MIN = 60_000;
  const mk = () => new LoginRateLimiter({ maxFailures: 5, windowMs: 15 * MIN, lockMs: 15 * MIN, perIpMax: 50, now: () => t });
  beforeEach(() => { t = 1_000_000; });

  it('allows five failures and blocks the sixth attempt', () => {
    const rl = mk();
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.check('dana', '1.1.1.1').allowed, true, `attempt ${i + 1}`);
      rl.fail('dana', '1.1.1.1');
    }
    const c = rl.check('dana', '1.1.1.1');
    assert.equal(c.allowed, false);
    assert.equal(c.retryAfterSec, 15 * 60);
  });

  it('scopes the lock to account+IP (and username case-insensitively)', () => {
    const rl = mk();
    for (let i = 0; i < 5; i++) { rl.fail('Dana', '1.1.1.1'); }
    assert.equal(rl.check('dana', '1.1.1.1').allowed, false);
    assert.equal(rl.check('dana', '2.2.2.2').allowed, true);
    assert.equal(rl.check('sam', '1.1.1.1').allowed, true);
  });

  it('the lock expires after lockMs', () => {
    const rl = mk();
    for (let i = 0; i < 5; i++) { rl.fail('dana', 'ip'); }
    t += 15 * MIN - 1000;
    assert.equal(rl.check('dana', 'ip').allowed, false);
    assert.equal(rl.check('dana', 'ip').retryAfterSec, 1);
    t += 1000;
    assert.equal(rl.check('dana', 'ip').allowed, true);
  });

  it('failures outside the window do not accumulate', () => {
    const rl = mk();
    for (let i = 0; i < 4; i++) { rl.fail('dana', 'ip'); }
    t += 15 * MIN;
    rl.fail('dana', 'ip');
    assert.equal(rl.check('dana', 'ip').allowed, true);
  });

  it('success resets the account counter', () => {
    const rl = mk();
    for (let i = 0; i < 4; i++) { rl.fail('dana', 'ip'); }
    rl.succeed('dana', 'ip');
    for (let i = 0; i < 4; i++) { rl.fail('dana', 'ip'); }
    assert.equal(rl.check('dana', 'ip').allowed, true);
    rl.fail('dana', 'ip');
    assert.equal(rl.check('dana', 'ip').allowed, false);
  });

  it('applies the per-IP cap across usernames', () => {
    const rl = mk();
    for (let i = 0; i < 49; i++) { rl.fail(`user${i}`, '9.9.9.9'); }
    assert.equal(rl.check('fresh-user', '9.9.9.9').allowed, true);
    rl.fail('user49', '9.9.9.9');
    assert.equal(rl.check('fresh-user', '9.9.9.9').allowed, false);
    assert.equal(rl.check('fresh-user', '8.8.8.8').allowed, true);
  });

  it('success does not clear the per-IP lock', () => {
    const rl = mk();
    for (let i = 0; i < 50; i++) { rl.fail(`u${i}`, 'ip'); }
    rl.succeed('u1', 'ip');
    assert.equal(rl.check('u1', 'ip').allowed, false);
  });

  describe('begin (in-flight reservation)', () => {
    it('admits at most maxFailures attempts in flight before any verdict; the rest are refused', () => {
      const rl = mk();
      const admitted: Array<{ fail(): void }> = [];
      let refused = 0;
      for (let i = 0; i < 12; i++) {
        const b = rl.begin('dana', '1.1.1.1');
        if (b.allowed) { admitted.push(b.attempt); } else { refused++; assert.equal(b.retryAfterSec, 15 * 60); }
      }
      assert.equal(admitted.length, 5);
      assert.equal(refused, 7);
      for (const a of admitted) { a.fail(); }
      assert.equal(rl.check('dana', '1.1.1.1').allowed, false, 'five failures lock the pair');
    });

    it('success clears failures but keeps other in-flight attempts counted', () => {
      const rl = mk();
      const a = rl.begin('dana', 'ip');
      const b = rl.begin('dana', 'ip');
      assert.ok(a.allowed && b.allowed);
      if (!a.allowed || !b.allowed) { return; }
      rl.fail('dana', 'ip');
      a.attempt.succeed();
      // 1 in flight (b) + 0 failures: four more may start, the fifth may not.
      const more = [1, 2, 3, 4, 5].map(() => rl.begin('dana', 'ip').allowed);
      assert.deepEqual(more, [true, true, true, true, false]);
      b.attempt.cancel();
    });

    it('cancel releases the slot without counting a failure; settling twice is a no-op', () => {
      const rl = mk();
      for (let i = 0; i < 20; i++) {
        const b = rl.begin('dana', 'ip');
        assert.equal(b.allowed, true, `attempt ${i}`);
        if (b.allowed) { b.attempt.cancel(); b.attempt.fail(); }
      }
      assert.equal(rl.check('dana', 'ip').allowed, true);
    });

    it('the per-IP cap counts in-flight attempts across usernames', () => {
      const rl = mk();
      let ok = 0;
      for (let i = 0; i < 60; i++) { if (rl.begin(`u${i}`, '9.9.9.9').allowed) { ok++; } }
      assert.equal(ok, 50);
      assert.equal(rl.begin('fresh', '8.8.8.8').allowed, true);
    });

    it('a locked pair is refused by begin with the lock remainder', () => {
      const rl = mk();
      for (let i = 0; i < 5; i++) { rl.fail('dana', 'ip'); }
      t += 60_000;
      const b = rl.begin('dana', 'ip');
      assert.equal(b.allowed, false);
      assert.equal(b.retryAfterSec, 14 * 60);
    });
  });

  it('prunes idle keys once the map is large', () => {
    const rl = new LoginRateLimiter({ now: () => t, maxKeys: 10 });
    for (let i = 0; i < 20; i++) { rl.fail(`u${i}`, `ip${i}`); }
    t += 16 * MIN;
    rl.fail('later', 'ipx');
    const sizes = rl as unknown as { accounts: Map<string, unknown>; ips: Map<string, unknown> };
    assert.ok(sizes.accounts.size <= 2, `accounts ${sizes.accounts.size}`);
    assert.ok(sizes.ips.size <= 2);
  });
});
