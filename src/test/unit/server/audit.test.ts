import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLog, AuditSecretError, AuditInput, findSecretKey, AUDIT_FILE } from '../../../server/audit';

function entry(over: Partial<AuditInput> = {}): AuditInput {
  return { actorUserId: 'u1', actorUsername: 'dana', action: 'prd.version-save', target: 'v1.0.0', ...over };
}

describe('AuditLog', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-audit-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('appends JSONL with ts and increasing seq', () => {
    const log = new AuditLog(dir);
    const a = log.append(entry());
    const b = log.append(entry({ action: 'plan.approve', projectId: 'p1', flags: ['self-approval'] }));
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(!Number.isNaN(Date.parse(a.ts)));
    const lines = fs.readFileSync(path.join(dir, AUDIT_FILE), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]).flags, ['self-approval']);
  });

  it('continues seq across a restart', () => {
    new AuditLog(dir).append(entry());
    new AuditLog(dir).append(entry());
    const log = new AuditLog(dir);
    assert.equal(log.append(entry()).seq, 3);
  });

  it('throws and writes nothing when a payload carries a secret-looking key', () => {
    const log = new AuditLog(dir);
    assert.throws(() => log.append(entry({ after: { apiKey: 'x' } })), AuditSecretError);
    assert.throws(() => log.append(entry({ before: { nested: [{ password: 'p' }] } })), AuditSecretError);
    assert.throws(() => log.append(entry({ after: { sessionToken: 't' } })), AuditSecretError);
    assert.throws(() => log.append(entry({ after: { masterKey: 'k' } })), AuditSecretError);
    assert.throws(() => log.append(entry({ after: { client_secret: 's' } })), AuditSecretError);
    assert.equal(fs.existsSync(path.join(dir, AUDIT_FILE)), false);
  });

  it('allows ordinary keys that merely contain "key" mid-word', () => {
    assert.equal(findSecretKey({ keyboard: 1, monkeys: 2, last4: 'abcd' }), null);
    assert.equal(findSecretKey({ engine: 'anthropic' }), null);
  });

  it('rejects an unknown action', () => {
    const log = new AuditLog(dir);
    assert.throws(() => log.append(entry({ action: 'gate.force' as AuditInput['action'] })), /Unknown audit action/);
  });

  it('skips a corrupted line on query and seq recovery', () => {
    const log = new AuditLog(dir);
    log.append(entry({ target: 'a' }));
    fs.appendFileSync(path.join(dir, AUDIT_FILE), '{not json\n{"seq":"x"}\n');
    log.append(entry({ target: 'b' }));
    const got = log.query();
    assert.deepEqual(got.map((e) => e.target), ['b', 'a']);
    assert.equal(new AuditLog(dir).append(entry()).seq, 3);
  });

  it('pages newest-first with before + limit, capped at 100', () => {
    const log = new AuditLog(dir);
    for (let i = 0; i < 130; i++) { log.append(entry({ target: `t${i}` })); }
    const page1 = log.query({ limit: 500 });
    assert.equal(page1.length, 100);
    assert.equal(page1[0].seq, 130);
    assert.equal(page1[99].seq, 31);
    const page2 = log.query({ before: page1[99].seq });
    assert.equal(page2.length, 30);
    assert.equal(page2[0].seq, 30);
    assert.equal(page2[29].seq, 1);
    assert.deepEqual(log.query({ before: 1 }), []);
    assert.equal(log.query({ limit: 5 }).length, 5);
  });

  it('filters by actor (id or username), action, project and time', () => {
    let t = Date.parse('2026-10-01T00:00:00.000Z');
    const log = new AuditLog(dir, { now: () => new Date((t += 60_000)) });
    log.append(entry({ actorUserId: 'u1', actorUsername: 'dana', action: 'prd.version-save', projectId: 'p1' }));
    log.append(entry({ actorUserId: 'u2', actorUsername: 'sam', action: 'plan.approve', projectId: 'p1' }));
    log.append(entry({ actorUserId: 'u2', actorUsername: 'sam', action: 'run.start', projectId: 'p2' }));
    assert.equal(log.query({ actor: 'sam' }).length, 2);
    assert.equal(log.query({ actor: 'u1' }).length, 1);
    assert.equal(log.query({ action: 'run.start' }).length, 1);
    assert.equal(log.query({ projectId: 'p1' }).length, 2);
    assert.equal(log.query({ from: '2026-10-01T00:02:00.000Z' }).length, 2);
    assert.equal(log.query({ to: '2026-10-01T00:02:00.000Z' }).length, 2);
  });

  it('rotates past the size limit and still queries across files', () => {
    let t = Date.parse('2026-10-01T00:00:00.000Z');
    const log = new AuditLog(dir, { rotateBytes: 600, now: () => new Date((t += 1000)) });
    for (let i = 0; i < 12; i++) { log.append(entry({ target: `t${i}` })); }
    const rotated = fs.readdirSync(dir).filter((n) => /^audit-.+\.jsonl$/.test(n));
    assert.ok(rotated.length >= 1, 'at least one rotated file');
    const all = log.query();
    assert.equal(all.length, 12);
    assert.deepEqual(all.map((e) => e.seq), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal(new AuditLog(dir).append(entry()).seq, 13);
  });
});
