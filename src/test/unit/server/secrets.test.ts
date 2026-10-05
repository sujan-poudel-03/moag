// ─── Engine API key store (AES-256-GCM under an HKDF-derived key) ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SecretStore, SECRETS_FILE, KEYED_ENGINE_ENV, KEYED_ENGINES, isKeyedEngine, NoMasterKeyError,
} from '../../../server/secrets';
import { startHarness, Harness, approvedProject, planWorker, gatedPlaylist, PRD_V1, waitFor } from './app-harness';

const MASTER = Buffer.from('master-secret-for-tests-0123456789', 'utf-8');
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-a91F';

describe('server secrets (engine key store)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-secrets-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const file = (): string => path.join(dir, SECRETS_FILE);

  it('KEYED_ENGINE_ENV is closed to anthropic and frozen', () => {
    assert.deepEqual({ ...KEYED_ENGINE_ENV }, { anthropic: 'ANTHROPIC_API_KEY' });
    assert.equal(Object.isFrozen(KEYED_ENGINE_ENV), true);
    assert.deepEqual([...KEYED_ENGINES], ['anthropic']);
    assert.equal(isKeyedEngine('anthropic'), true);
    for (const bad of ['claude', 'toString', '__proto__', '', 42, null]) { assert.equal(isKeyedEngine(bad), false, String(bad)); }
  });

  it('round-trips a key; the raw file never contains the plaintext', () => {
    const s = new SecretStore(dir, MASTER, () => new Date('2026-10-04T12:00:00Z'));
    const st = s.set('anthropic', KEY);
    assert.deepEqual(st, { set: true, last4: 'a91F', updatedAt: '2026-10-04T12:00:00.000Z', readable: true });
    const raw = fs.readFileSync(file(), 'utf-8');
    assert.equal(raw.includes(KEY), false);
    assert.equal(raw.includes('THIS-IS-A-FAKE'), false);
    assert.equal(raw.includes(Buffer.from(KEY).toString('base64')), false);
    assert.deepEqual(s.decryptFor(['anthropic']), { ANTHROPIC_API_KEY: KEY });
  });

  it('uses a fresh IV per write', () => {
    const s = new SecretStore(dir, MASTER);
    s.set('anthropic', KEY);
    const a = JSON.parse(fs.readFileSync(file(), 'utf-8')).entries.anthropic;
    s.set('anthropic', KEY);
    const b = JSON.parse(fs.readFileSync(file(), 'utf-8')).entries.anthropic;
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it('writes the store with mode 0600', function () {
    if (process.platform === 'win32') { this.skip(); }
    new SecretStore(dir, MASTER).set('anthropic', KEY);
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  });

  it('a flipped ciphertext byte gives readable:false and no throw', () => {
    const s = new SecretStore(dir, MASTER);
    s.set('anthropic', KEY);
    const doc = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    const ct = Buffer.from(doc.entries.anthropic.ct, 'base64');
    ct[0] ^= 0x01;
    doc.entries.anthropic.ct = ct.toString('base64');
    fs.writeFileSync(file(), JSON.stringify(doc));
    const st = s.status('anthropic');
    assert.equal(st.set, true);
    assert.equal(st.readable, false);
    assert.deepEqual(s.decryptFor(['anthropic']), {});
  });

  it('a forged auth tag gives readable:false', () => {
    const s = new SecretStore(dir, MASTER);
    s.set('anthropic', KEY);
    const doc = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    doc.entries.anthropic.tag = Buffer.alloc(16).toString('base64');
    fs.writeFileSync(file(), JSON.stringify(doc));
    assert.equal(s.status('anthropic').readable, false);
  });

  it('a wrong master key gives readable:false and injects nothing', () => {
    new SecretStore(dir, MASTER).set('anthropic', KEY);
    const wrong = new SecretStore(dir, Buffer.from('a-different-master-secret-xyz', 'utf-8'));
    assert.deepEqual(wrong.status('anthropic'), { set: true, last4: 'a91F', updatedAt: wrong.status('anthropic').updatedAt, readable: false });
    assert.deepEqual(wrong.decryptFor(['anthropic']), {});
  });

  it('without a master key: set throws NoMasterKeyError and writes nothing; status is not-set', () => {
    const s = new SecretStore(dir, null);
    assert.equal(s.hasMasterKey(), false);
    assert.throws(() => s.set('anthropic', KEY), NoMasterKeyError);
    assert.equal(fs.existsSync(file()), false);
    assert.deepEqual(s.status('anthropic'), { set: false, last4: null, updatedAt: null, readable: false });
  });

  it('refuses a non-keyed engine and malformed key values', () => {
    const s = new SecretStore(dir, MASTER);
    assert.throws(() => s.set('claude', KEY), /no stored key/);
    for (const bad of ['short', 'has space inside key', 'line\nbreak-key-value', 'x'.repeat(513)]) {
      assert.throws(() => s.set('anthropic', bad), /printable/, JSON.stringify(bad));
    }
    assert.equal(fs.existsSync(file()), false);
  });

  it('clear removes the entry; clearing again is false', () => {
    const s = new SecretStore(dir, MASTER);
    s.set('anthropic', KEY);
    assert.equal(s.clear('anthropic'), true);
    assert.equal(s.status('anthropic').set, false);
    assert.equal(s.clear('anthropic'), false);
    assert.equal(fs.readFileSync(file(), 'utf-8').includes('a91F'), false);
  });

  it('decryptFor ignores engines without a stored key and corrupt files', () => {
    const s = new SecretStore(dir, MASTER);
    assert.deepEqual(s.decryptFor(['claude', 'codex', 'anthropic']), {});
    s.set('anthropic', KEY);
    assert.deepEqual(s.decryptFor(['claude', 'codex']), {});
    fs.writeFileSync(file(), '{not json');
    assert.deepEqual(s.decryptFor(['anthropic']), {});
    assert.equal(s.status('anthropic').set, false);
  });
});

describe('server secrets: injection into worker envs', function () {
  this.timeout(20000);
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ secrets: (d) => { const s = new SecretStore(d, MASTER); s.set('anthropic', KEY); return s; } });
  });
  afterEach(async () => { await h.close(); });

  it('a run on a claude-only plan gets no ANTHROPIC_API_KEY', async () => {
    const { projectId, planId } = await approvedProject(h);
    for (const w of h.workers) { assert.equal('ANTHROPIC_API_KEY' in w.spec.env, false, `${w.job.kind} job`); }
    const r = await h.request('POST', `/api/projects/${projectId}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const w = h.workers.at(-1)!;
    assert.equal(w.job.kind, 'run');
    assert.equal('ANTHROPIC_API_KEY' in w.spec.env, false);
    assert.equal(JSON.stringify(w.spec.env).includes(KEY), false);
  });

  it('a job for an anthropic project gets the key, and the key is redacted from what the worker reports', async () => {
    const c = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Api', source: { kind: 'path', path: 'other' }, stack: 'python', defaultEngine: 'anthropic' },
    });
    assert.equal(c.status, 201, c.raw);
    const id = (c.body.project as { id: string }).id;
    await h.request('POST', `/api/projects/${id}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
    h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
    const g = await h.request('POST', `/api/projects/${id}/plans`, { as: 'po', body: { mode: 'initial' } });
    assert.equal(g.status, 202, g.raw);
    const planId = (g.body.plan as { id: string }).id;
    await waitFor(() => h.state.load(id).plans[0]?.status === 'pending');
    assert.equal(h.workers.at(-1)!.spec.env.ANTHROPIC_API_KEY, KEY, 'plan generation on anthropic gets the key');

    const hash = h.state.load(id).plans[0].contentHash;
    await h.request('POST', `/api/projects/${id}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
    h.onSpawn = () => { /* stay running */ };
    const r = await h.request('POST', `/api/projects/${id}/runs`, { as: 'reviewer', body: { planId } });
    assert.equal(r.status, 202, r.raw);
    const w = h.workers.at(-1)!;
    assert.equal(w.spec.env.ANTHROPIC_API_KEY, KEY);
    w.line({ event: 'task-error-tail', id: 't-impl', tail: `401 for key ${KEY}` });
    w.stderr.emit('data', Buffer.from(`boom ${KEY}\n`));
    w.exit(2);
    await waitFor(() => h.state.load(id).runs[0].status === 'error');
    const runDir = h.state.runDir(id, h.state.load(id).runs[0].id);
    const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf-8');
    assert.equal(events.includes(KEY), false);
    assert.ok(events.includes('[REDACTED]'));
    assert.equal(String(h.state.load(id).runs[0].errorTail ?? '').includes(KEY), false);
  });
});
