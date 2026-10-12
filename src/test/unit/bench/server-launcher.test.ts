import { strict as assert } from 'assert';
import { buildServerEnv, LaunchOptions } from '../../../bench/server-launcher';
import { loadServerConfig } from '../../../server/config';

// ─── The bench server's built environment ───

describe('bench server-launcher buildServerEnv', () => {
  const opts = (over: Partial<LaunchOptions> = {}): LaunchOptions => ({
    outDir: 'bench-out', fakeBinDir: null, passEnv: [], maxUsdPerCall: 1, gateTimeoutMs: null, ...over,
  });

  it('passes the scenario gate timeout as MOAG_GATE_TIMEOUT_MS, which the server accepts', () => {
    const { env } = buildServerEnv({ PATH: '/usr/bin' }, opts({ gateTimeoutMs: 1_800_000 }));
    assert.equal(env.MOAG_GATE_TIMEOUT_MS, '1800000');
    const loaded = loadServerConfig(env);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
    assert.equal(loaded.ok && loaded.config.gateTimeoutMs, 1_800_000);
  });

  it('sets no gate timeout when none is given, and never inherits one from the base env', () => {
    const { env } = buildServerEnv({ PATH: '/usr/bin', MOAG_GATE_TIMEOUT_MS: '5000' }, opts());
    assert.equal('MOAG_GATE_TIMEOUT_MS' in env, false, 'MOAG_* from the caller is dropped');
    const loaded = loadServerConfig(env);
    assert.equal(loaded.ok && loaded.config.gateTimeoutMs, null);
  });

  it('a plain-JS caller that omits gateTimeoutMs still gets a server that boots', () => {
    const legacy = { outDir: 'bench-out', fakeBinDir: null, passEnv: [], maxUsdPerCall: 1 } as unknown as LaunchOptions;
    const { env } = buildServerEnv({ PATH: '/usr/bin' }, legacy);
    assert.equal('MOAG_GATE_TIMEOUT_MS' in env, false);
    assert.ok(loadServerConfig(env).ok);
  });
});
