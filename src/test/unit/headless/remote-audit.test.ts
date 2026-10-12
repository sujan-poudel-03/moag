// ─── Remote runs: audit log and outbox ───

import { strict as assert } from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AUDIT_FILE, AUDIT_ROTATED_FILE, auditLine, RemoteAudit } from '../../../headless/remote-audit';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-audit-')));
}

const KEY = 'onosoo_live_' + 'D'.repeat(43);
const PRD = '# Secret PRD\nThe launch codes are in the vault. ' + 'x'.repeat(500);

function allBytes(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? allBytes(p) : fs.readFileSync(p, 'utf-8');
  }
  return out;
}

describe('remote audit log', () => {
  it('writes the fixed fields only: the PRD as size and sha256, never its text', () => {
    const dir = tmp();
    const audit = new RemoteAudit(dir);
    audit.appendOrThrow({ id: 'c1', kind: 'start-run', phase: 'received', requestedBy: 'Ana', createdAt: '2026-10-11T00:00:00Z', projectId: 'web', prd: PRD });
    const [line] = audit.readAll();
    assert.deepEqual(Object.keys(line).sort(), ['at', 'created_at', 'decision', 'id', 'kind', 'message', 'phase', 'prd', 'project_id', 'requested_by', 'run_id']);
    assert.deepEqual(line.prd, { bytes: Buffer.byteLength(PRD), sha256: createHash('sha256').update(PRD).digest('hex') });
    const bytes = allBytes(dir);
    assert.ok(!bytes.includes('launch codes'));
    assert.ok(!bytes.includes(KEY));
    if (process.platform !== 'win32') { assert.equal(fs.statSync(audit.file).mode & 0o777, 0o600); }
  });

  it('auditLine has no field for anything else in a payload', () => {
    const l = auditLine({ id: 'c', kind: 'stop', phase: 'received', ...({ payload: { key: KEY } } as object) } as never, new Date(0));
    assert.ok(!JSON.stringify(l).includes(KEY));
  });

  it('reconciles on restart: every id seen, and those that never reached final', () => {
    const dir = tmp();
    const a = new RemoteAudit(dir);
    a.appendOrThrow({ id: 'done', kind: 'stop', phase: 'received' });
    a.appendOrThrow({ id: 'done', kind: 'stop', phase: 'final', decision: 'succeeded' });
    a.appendOrThrow({ id: 'cut', kind: 'start-run', phase: 'received' });
    a.appendOrThrow({ id: 'cut', kind: 'start-run', phase: 'running', runId: 'r1' });
    fs.appendFileSync(a.file, '{"torn":');
    const { seen, unfinished } = new RemoteAudit(dir).reconcileOnBoot();
    assert.deepEqual([...seen].sort(), ['cut', 'done']);
    assert.deepEqual(unfinished, [{ id: 'cut', kind: 'start-run' }]);
  });

  it('rotates to audit.1.jsonl at the size limit, and still reads both', () => {
    const dir = tmp();
    const audit = new RemoteAudit(dir, { maxBytes: 300 });
    for (let i = 0; i < 6; i++) { audit.appendOrThrow({ id: `c${i}`, kind: 'stop', phase: 'received' }); }
    assert.ok(fs.existsSync(path.join(dir, 'remote', AUDIT_ROTATED_FILE)));
    assert.ok(fs.statSync(path.join(dir, 'remote', AUDIT_FILE)).size < 600);
    assert.ok(audit.reconcileOnBoot().seen.has('c5'));
  });

  it('a failed append throws', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'remote', AUDIT_FILE), { recursive: true });
    const audit = new RemoteAudit(dir, { maxBytes: Number.MAX_SAFE_INTEGER });
    assert.throws(() => audit.appendOrThrow({ id: 'c', kind: 'stop', phase: 'received' }));
  });
});

describe('remote result outbox', () => {
  it('survives a restart; a later result replaces an earlier one; removal works', () => {
    const dir = tmp();
    const a = new RemoteAudit(dir);
    a.outboxAdd('c1', { status: 'running', message: 'Started' });
    a.outboxAdd('c2', { status: 'rejected', message: 'No' });
    a.outboxAdd('c1', { status: 'succeeded', message: 'Run started', run_id: 'r1' });
    const b = new RemoteAudit(dir);
    assert.deepEqual(b.outboxList(), [
      { id: 'c2', result: { status: 'rejected', message: 'No' } },
      { id: 'c1', result: { status: 'succeeded', message: 'Run started', run_id: 'r1' } },
    ]);
    b.outboxRemove('c2');
    assert.deepEqual(new RemoteAudit(dir).outboxList().map((x) => x.id), ['c1']);
  });

  it('a corrupt outbox reads as empty', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'remote', 'outbox.json'), '{nope');
    assert.deepEqual(new RemoteAudit(dir).outboxList(), []);
  });
});
