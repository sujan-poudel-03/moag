// ─── Engine status: probe cache, Engines screen rows, key routes, run-start availability ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  EngineStatusCache, buildEngineRows, PROBED_ENGINES, ENGINE_ROW_ORDER,
} from '../../../server/engines';
import { KeyStatus, SecretStore, SECRETS_FILE } from '../../../server/secrets';
import { EngineId } from '../../../models/types';
import { startHarness, Harness, approvedProject, waitFor, FakeWorker } from './app-harness';
import { PROBE_JOB_ID } from '../../../server/app';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

const NO_KEY: KeyStatus = { set: false, last4: null, updatedAt: null, readable: false };
const noKey = (): KeyStatus => NO_KEY;
const MASTER = Buffer.from('master-secret-for-tests-0123456789', 'utf-8');
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-a91F';

describe('server engines (pure)', () => {
  it('PROBED_ENGINES is exactly ENGINE_PRIORITY from engine-detection', () => {
    const det = proxyquire('../../../engine-detection', {
      vscode: require('../mocks/vscode'),
      './adapters/engine': { checkEngineAvailability: async () => new Map() },
    });
    assert.deepEqual([...PROBED_ENGINES], [...det.ENGINE_PRIORITY]);
  });

  it('before any probe: CLI rows are available:null, auth unknown; availability is unknown', () => {
    const c = new EngineStatusCache();
    const rows = buildEngineRows(c.snapshot(), noKey);
    assert.deepEqual(rows.map((r) => r.id), [...ENGINE_ROW_ORDER]);
    for (const id of PROBED_ENGINES) {
      const r = rows.find((x) => x.id === id)!;
      assert.equal(r.available, null);
      assert.equal(r.auth, 'unknown');
      assert.equal(c.isAvailable(id, noKey), undefined);
    }
  });

  it('a fake probe result gives the rows (installed, version; missing; auth always unknown)', () => {
    const c = new EngineStatusCache(() => new Date('2026-10-04T14:31:00Z'));
    c.begin();
    assert.equal(c.snapshot().inProgress, true);
    c.record([
      { id: 'claude', available: true, version: '2.1.4' },
      { id: 'codex', available: true, version: '0.48.0' },
      { id: 'gemini', available: false },
      // ollama not reported; an extra unsupported row is ignored
      { id: 'custom', available: true },
    ]);
    const snap = c.snapshot();
    assert.equal(snap.inProgress, false);
    assert.equal(snap.checkedAt, '2026-10-04T14:31:00.000Z');
    const rows = buildEngineRows(snap, noKey);
    const by = (id: EngineId) => rows.find((r) => r.id === id)!;
    assert.deepEqual(by('claude'), { id: 'claude', kind: 'cli', supported: true, available: true, version: '2.1.4', error: null, auth: 'unknown' });
    assert.equal(by('gemini').available, false);
    assert.equal(by('ollama').available, false);
    assert.match(String(by('ollama').error), /Not reported/);
    for (const id of ['copilot', 'custom'] as EngineId[]) {
      assert.equal(by(id).supported, false);
      assert.equal(by(id).available, false);
    }
    for (const r of rows.filter((x) => x.kind === 'cli' && x.supported)) { assert.equal(r.auth, 'unknown', r.id); }
    assert.equal(c.isAvailable('claude', noKey), true);
    assert.equal(c.isAvailable('gemini', noKey), false);
    assert.equal(c.isAvailable('custom', noKey), false);
  });

  it('probe failure gives available:false with the error on every CLI row', () => {
    const c = new EngineStatusCache();
    c.fail('spawn ENOENT');
    const rows = buildEngineRows(c.snapshot(), noKey);
    for (const id of PROBED_ENGINES) {
      const r = rows.find((x) => x.id === id)!;
      assert.equal(r.available, false);
      assert.equal(r.error, 'spawn ENOENT');
    }
    assert.equal(c.snapshot().error, 'spawn ENOENT');
    assert.equal(c.isAvailable('claude', noKey), false);
  });

  it('anthropic is an API row: key status decides availability and auth, never a key value', () => {
    const c = new EngineStatusCache();
    const set: KeyStatus = { set: true, last4: 'a91F', updatedAt: '2026-10-04T00:00:00.000Z', readable: true };
    const broken: KeyStatus = { ...set, readable: false };
    const row = (k: KeyStatus) => buildEngineRows(c.snapshot(), () => k).find((r) => r.id === 'anthropic')!;
    assert.deepEqual({ kind: row(NO_KEY).kind, available: row(NO_KEY).available, auth: row(NO_KEY).auth }, { kind: 'api', available: false, auth: 'key-not-set' });
    assert.equal(row(set).auth, 'key-set');
    assert.equal(row(set).available, true);
    assert.equal(row(broken).auth, 'key-unreadable');
    assert.equal(row(broken).available, false);
    assert.equal(c.isAvailable('anthropic', () => set), true);
    assert.equal(c.isAvailable('anthropic', () => broken), false);
  });
});

describe('server engines (routes)', function () {
  this.timeout(20000);
  let h: Harness;
  afterEach(async () => { if (h) { await h.close(); } });

  const probe = (rows: unknown[] | null, code = 0) => (w: FakeWorker): void => {
    if (w.job.kind !== 'probe') { return; }
    if (rows) { w.line({ event: 'probe-result', engines: rows }); }
    w.exit(code);
  };

  it('GET /api/admin/engines is admin-only and lists every engine with no probe yet', async () => {
    h = await startHarness();
    for (const who of ['po', 'reviewer', 'approver']) {
      assert.equal((await h.request('GET', '/api/admin/engines', { as: who })).status, 403, who);
    }
    const r = await h.request('GET', '/api/admin/engines', { as: 'admin' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.checkedAt, null);
    assert.equal(r.body.masterKeyConfigured, false);
    assert.deepEqual((r.body.rows as Array<{ id: string }>).map((x) => x.id), [...ENGINE_ROW_ORDER]);
  });

  it('recheck spawns a probe worker with no credentials and caches its result', async () => {
    h = await startHarness({ secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
    h.onSpawn = probe([{ id: 'claude', available: true, version: '2.1.4' }, { id: 'codex', available: false }, { id: 'gemini', available: false }, { id: 'ollama', available: true, version: '0.12.1' }]);
    const r = await h.request('POST', '/api/admin/engines/recheck', { as: 'admin', body: {} });
    assert.equal(r.status, 202, r.raw);
    const w = h.workers.at(-1)!;
    assert.equal(w.job.kind, 'probe');
    assert.equal('ANTHROPIC_API_KEY' in w.spec.env, false, 'the probe carries no engine key');
    for (const k of ['CI', 'MOAG_MASTER_KEY', 'SESSION_SECRET']) { assert.equal(k in w.spec.env, false, k); }
    await waitFor(() => !h.app.jobs.isActive(PROBE_JOB_ID) && h.app.engines.snapshot().checkedAt !== null);
    const g = await h.request('GET', '/api/admin/engines', { as: 'admin' });
    const rows = g.body.rows as Array<{ id: string; available: boolean | null; version: string | null; auth: string; key?: KeyStatus }>;
    assert.equal(rows.find((x) => x.id === 'claude')!.version, '2.1.4');
    assert.equal(rows.find((x) => x.id === 'codex')!.available, false);
    const anth = rows.find((x) => x.id === 'anthropic')!;
    assert.equal(anth.auth, 'key-set');
    assert.equal(anth.key!.last4, 'a91F');
    assert.equal(g.raw.includes(KEY), false, 'the GET response never carries the full key');
    assert.equal(g.raw.includes('THIS-IS-A-FAKE'), false);
    const av = await h.request('GET', '/api/engines/availability', { as: 'po' });
    const engines = av.body.engines as Array<{ id: string; available: boolean | null }>;
    assert.equal(engines.find((e) => e.id === 'claude')!.available, true);
    assert.equal(engines.find((e) => e.id === 'codex')!.available, false);
    assert.equal(engines.find((e) => e.id === 'anthropic')!.available, true);
    assert.equal(engines.some((e) => e.id === 'custom' || e.id === 'copilot'), false);
    assert.equal(h.auditEntries().length, 0, 'a re-check is not an audited action');
  });

  it('a probe that exits without a result marks every CLI unavailable with an error', async () => {
    h = await startHarness();
    h.onSpawn = (w) => { if (w.job.kind === 'probe') { w.stderr.emit('data', Buffer.from('probe crashed\n')); w.exit(2); } };
    assert.equal(h.app.probeEngines(), true);
    await waitFor(() => h.app.engines.snapshot().checkedAt !== null);
    const g = await h.request('GET', '/api/admin/engines', { as: 'admin' });
    const claude = (g.body.rows as Array<{ id: string; available: boolean; error: string }>).find((x) => x.id === 'claude')!;
    assert.equal(claude.available, false);
    assert.match(claude.error, /probe crashed/);
    assert.match(String(g.body.error), /probe crashed/);
  });

  it('a spawn error during the probe is recorded as a failed probe', async () => {
    h = await startHarness();
    h.onSpawn = (w) => { if (w.job.kind === 'probe') { w.emit('error', new Error('spawn EACCES')); } };
    h.app.probeEngines();
    await waitFor(() => h.app.engines.snapshot().checkedAt !== null);
    assert.equal(h.app.engines.snapshot().error, 'spawn EACCES');
    assert.equal(h.app.jobs.isActive(PROBE_JOB_ID), false);
    assert.equal(fs.existsSync(path.join(h.dataDir, 'projects', PROBE_JOB_ID, 'job.lock')), false, 'no lock left behind');
  });

  it('a second recheck while one is running is 409 and spawns nothing', async () => {
    h = await startHarness();
    const r1 = await h.request('POST', '/api/admin/engines/recheck', { as: 'admin', body: {} });
    assert.equal(r1.status, 202);
    const n = h.workers.length;
    const r2 = await h.request('POST', '/api/admin/engines/recheck', { as: 'admin', body: {} });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, 'probe-active');
    assert.equal(h.workers.length, n);
  });

  it('a recheck without CSRF is 403 and spawns nothing', async () => {
    h = await startHarness();
    const r = await h.request('POST', '/api/admin/engines/recheck', { as: 'admin', body: {}, csrf: false });
    assert.equal(r.status, 403);
    assert.equal(h.workers.length, 0);
  });

  it('run start is 409 engine-unavailable when the probe says the project engine is missing', async () => {
    h = await startHarness();
    const { projectId, planId } = await approvedProject(h);
    h.onSpawn = probe([{ id: 'claude', available: false }, { id: 'codex', available: true }, { id: 'gemini', available: false }, { id: 'ollama', available: false }]);
    h.app.probeEngines();
    await waitFor(() => h.app.engines.snapshot().checkedAt !== null);
    h.onSpawn = () => { /* stay running */ };
    const before = h.workers.length;
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'engine-unavailable');
    assert.equal(h.workers.length, before);
    assert.equal(h.auditEntries().filter((e) => e.action === 'run.start').length, 0);
  });

  // ─── API keys ───

  it('PUT key: admin-only; stores encrypted; response and audit carry no key characters', async () => {
    h = await startHarness({ secrets: (d) => new SecretStore(d, MASTER) });
    for (const who of ['po', 'reviewer', 'approver']) {
      const r = await h.request('PUT', '/api/admin/engines/anthropic/key', { as: who, body: { value: KEY } });
      assert.equal(r.status, 403, who);
    }
    assert.equal(fs.existsSync(path.join(h.dataDir, SECRETS_FILE)), false, 'refused requests store nothing');
    const r = await h.request('PUT', '/api/admin/engines/anthropic/key', { as: 'admin', body: { value: KEY } });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.raw.includes(KEY), false);
    assert.deepEqual((r.body.status as KeyStatus).last4, 'a91F');
    const entries = h.auditEntries().filter((e) => e.action === 'engine.key-set');
    assert.equal(entries.length, 1);
    const line = JSON.stringify(entries[0]);
    assert.equal(line.includes(KEY), false);
    assert.equal(line.includes('a91F'), false, 'not even the last 4 reach the audit log');
    assert.equal(entries[0].target, 'anthropic');
    assert.equal(fs.readFileSync(path.join(h.dataDir, SECRETS_FILE), 'utf-8').includes(KEY), false);
    // Rotation is audited as another key-set.
    await h.request('PUT', '/api/admin/engines/anthropic/key', { as: 'admin', body: { value: KEY + 'x' } });
    const rot = h.auditEntries().filter((e) => e.action === 'engine.key-set');
    assert.deepEqual(rot[1].after, { rotated: true });
  });

  it('PUT key: unknown/unkeyed engine is 404; malformed value or extra field is 400; nothing stored or audited', async () => {
    h = await startHarness({ secrets: (d) => new SecretStore(d, MASTER) });
    for (const engine of ['claude', 'copilot', 'nope']) {
      const r = await h.request('PUT', `/api/admin/engines/${engine}/key`, { as: 'admin', body: { value: KEY } });
      assert.equal(r.status, 404, engine);
    }
    for (const b of [{ value: 'short' }, { value: 'has a space in it' }, { value: KEY, extra: 1 }, {}]) {
      const r = await h.request('PUT', '/api/admin/engines/anthropic/key', { as: 'admin', body: b });
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.raw.includes(KEY), false, 'a validation error never echoes the key');
    }
    assert.equal(fs.existsSync(path.join(h.dataDir, SECRETS_FILE)), false);
    assert.equal(h.auditEntries().length, 0);
  });

  it('PUT key without a master key is 503 and stores nothing', async () => {
    h = await startHarness();
    const r = await h.request('PUT', '/api/admin/engines/anthropic/key', { as: 'admin', body: { value: KEY } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'no-master-key');
    assert.equal(fs.existsSync(path.join(h.dataDir, SECRETS_FILE)), false);
    assert.equal(h.auditEntries().length, 0);
  });

  it('DELETE key: admin-only, audited once as engine.key-clear; clearing nothing is not audited', async () => {
    h = await startHarness({ secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
    assert.equal((await h.request('DELETE', '/api/admin/engines/anthropic/key', { as: 'po', body: {} })).status, 403);
    assert.equal((await h.request('DELETE', '/api/admin/engines/anthropic/key', { as: 'admin', body: {}, csrf: false })).status, 403);
    const r = await h.request('DELETE', '/api/admin/engines/anthropic/key', { as: 'admin', body: {} });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.cleared, true);
    assert.equal((r.body.status as KeyStatus).set, false);
    const again = await h.request('DELETE', '/api/admin/engines/anthropic/key', { as: 'admin', body: {} });
    assert.equal(again.body.cleared, false);
    assert.equal(h.auditEntries().filter((e) => e.action === 'engine.key-clear').length, 1);
  });

  it('a tampered key file is reported as unreadable, not a 500', async () => {
    h = await startHarness({ secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
    const f = path.join(h.dataDir, SECRETS_FILE);
    const doc = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const ct = Buffer.from(doc.entries.anthropic.ct, 'base64');
    ct[1] ^= 0xff;
    doc.entries.anthropic.ct = ct.toString('base64');
    fs.writeFileSync(f, JSON.stringify(doc));
    const g = await h.request('GET', '/api/admin/engines', { as: 'admin' });
    assert.equal(g.status, 200);
    const anth = (g.body.rows as Array<{ id: string; auth: string; available: boolean }>).find((x) => x.id === 'anthropic')!;
    assert.equal(anth.auth, 'key-unreadable');
    assert.equal(anth.available, false);
  });
});
