// ─── Server standards store: versions move forward, approved ones never change ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_STANDARDS_VERSIONS, ProposeInput, StandardsStore, StandardsStoreError, StandardsVersionRecord, enforcementReview, inEffectBefore, severityReview,
  standardsChangeAudit, designReview,
} from '../../../server/standards-store';
import { templateDesign } from '../../../standards/design';
import { AuditLog } from '../../../server/audit';
import { enforcementChangesBetween, enforcementFieldsChanged, profileHash, severityChangesBetween } from '../../../standards/profile';
import { sampleProfile, sampleProvenance } from '../standards/fixtures';

const P = 'p1';
const AT = new Date('2026-10-05T10:00:00.000Z');

function proposal(over: Partial<ProposeInput> = {}): ProposeInput {
  return { profile: sampleProfile(), provenance: sampleProvenance(), origin: 'user', proposedBy: 'u-po', baseVersion: null, ...over };
}

function refusal(fn: () => unknown): StandardsStoreError {
  try { fn(); } catch (err) {
    assert.ok(err instanceof StandardsStoreError, `expected a StandardsStoreError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected a refusal');
}

describe('server standards store', () => {
  let dir: string;
  let store: StandardsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stdstore-'));
    store = new StandardsStore(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const onDisk = (): { schemaVersion: number; migrated: boolean; versions: StandardsVersionRecord[] } =>
    JSON.parse(fs.readFileSync(store.filePath(P), 'utf-8'));

  it('a project with no file has no versions, nothing pending and nothing in effect', () => {
    assert.equal(store.exists(P), false);
    assert.deepEqual(store.load(P), { migrated: false, versions: [] });
    assert.equal(store.effective(P), null);
    assert.equal(store.pending(P), null);
  });

  it('a proposal is version 1, pending, hashed, and leaves nothing in effect', () => {
    const v = store.propose(P, proposal(), AT);
    assert.equal(v.version, 1);
    assert.equal(v.status, 'pending');
    assert.equal(v.baseVersion, null);
    assert.equal(v.contentHash, profileHash(sampleProfile()));
    assert.equal(v.proposedAt, AT.toISOString());
    assert.equal(store.exists(P), true);
    assert.equal(store.effective(P), null);
    assert.equal(store.pending(P)?.version, 1);
    assert.equal(onDisk().schemaVersion, 1);
    assert.equal(onDisk().migrated, false);
  });

  it('approving puts the version in effect; a later proposal leaves the effective version unchanged', () => {
    const v1 = store.propose(P, proposal(), AT);
    const approved = store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decision, 'approved');
    assert.equal(approved.decidedBy, 'u-rev');

    const next = sampleProfile();
    next.freeText = 'Prefer smaller modules.';
    const v2 = store.propose(P, proposal({ profile: next, baseVersion: 1 }), AT);
    assert.equal(v2.version, 2);
    assert.equal(v2.baseVersion, 1);
    assert.equal(store.effective(P)?.version, 1, 'v1 stays in effect until v2 is approved');
    assert.equal(store.pending(P)?.version, 2);

    store.approve(P, 2, { contentHash: v2.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v2.contentHash }, AT);
    assert.equal(store.effective(P)?.version, 2);
    assert.equal(store.get(P, 1)?.status, 'approved', 'the replaced version is still an approved record');
  });

  it('an approved version cannot be mutated by any method', () => {
    const v1 = store.propose(P, proposal(), AT);
    store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    const before = JSON.stringify(onDisk().versions[0]);

    assert.equal(refusal(() => store.approve(P, 1, { contentHash: v1.contentHash, by: 'someone-else', acknowledgedEnforcementHash: v1.contentHash })).code, 'already-decided');
    assert.equal(refusal(() => store.reject(P, 1, { reason: 'changed my mind', by: 'u-rev' })).code, 'already-decided');
    assert.equal(refusal(() => store.acceptDefaults(P, { contentHash: v1.contentHash, by: 'u-admin', acknowledgedEnforcementHash: v1.contentHash })).code, 'not-acceptable');
    store.propose(P, proposal({ baseVersion: 1 }), AT);
    store.reject(P, 2, { reason: 'no', by: 'u-rev' }, AT);

    assert.equal(JSON.stringify(onDisk().versions[0]), before, 'the approved record is byte-identical');

    // Returned records are copies: editing one never reaches the store.
    const copy = store.effective(P)!;
    copy.profile.freeText = 'tampered';
    copy.status = 'rejected';
    assert.equal(store.effective(P)?.profile.freeText, 'Prefer small modules.');
    assert.equal(JSON.stringify(onDisk().versions[0]), before);
  });

  it('a second proposal supersedes the first, and the superseded one can no longer be approved', () => {
    const v1 = store.propose(P, proposal(), AT);
    const v2 = store.propose(P, proposal({ baseVersion: 1 }), AT);
    assert.equal(store.get(P, 1)?.status, 'superseded');
    assert.equal(store.pending(P)?.version, 2);
    assert.equal(onDisk().versions.filter((v) => v.status === 'pending').length, 1);
    const err = refusal(() => store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }));
    assert.equal(err.code, 'already-decided');
    assert.equal(err.details?.status, 'superseded');
    assert.equal(v2.status, 'pending');
  });

  it('a stale baseVersion is refused and writes nothing', () => {
    store.propose(P, proposal(), AT);
    const before = fs.readFileSync(store.filePath(P), 'utf-8');
    const err = refusal(() => store.propose(P, proposal({ baseVersion: null })));
    assert.equal(err.code, 'stale');
    assert.equal(err.details?.latestVersion, 1);
    assert.equal(refusal(() => store.propose(P, proposal({ baseVersion: 7 }))).code, 'stale');
    assert.equal(fs.readFileSync(store.filePath(P), 'utf-8'), before);
  });

  it('approve refuses a wrong content hash and an unknown version', () => {
    store.propose(P, proposal(), AT);
    assert.equal(refusal(() => store.approve(P, 1, { contentHash: 'f'.repeat(64), by: 'u-rev' })).code, 'hash-mismatch');
    assert.equal(refusal(() => store.approve(P, 9, { contentHash: 'f'.repeat(64), by: 'u-rev' })).code, 'not-found');
    assert.equal(store.pending(P)?.version, 1, 'still pending');
  });

  it('reject records the reason and leaves the effective version alone', () => {
    const v1 = store.propose(P, proposal(), AT);
    store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    store.propose(P, proposal({ baseVersion: 1 }), AT);
    const rejected = store.reject(P, 2, { reason: 'no test dir', by: 'u-rev' }, AT);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'no test dir');
    assert.equal(rejected.decision, undefined);
    assert.equal(store.effective(P)?.version, 1);
    assert.equal(store.pending(P), null);
  });

  it('an invalid profile or provenance is refused with the validator errors', () => {
    const bad = { ...sampleProfile(), surprise: true };
    const err = refusal(() => store.propose(P, proposal({ profile: bad })));
    assert.equal(err.code, 'invalid-standards');
    assert.ok((err.details?.errors as string[]).some((e) => e.includes('surprise')));
    assert.equal(refusal(() => store.propose(P, proposal({ provenance: {} }))).code, 'invalid-standards');
    assert.equal(store.exists(P), false, 'nothing was written');
  });

  it('accept-defaults works only on a migrated project whose pending version is the untouched auto proposal', () => {
    // Not migrated: refused.
    const fresh = store.propose(P, proposal({ origin: 'auto', proposedBy: 'system' }), AT);
    assert.equal(refusal(() => store.acceptDefaults(P, { contentHash: fresh.contentHash, by: 'u-admin', acknowledgedEnforcementHash: fresh.contentHash })).code, 'not-acceptable');

    // Migrated + auto: accepted, recorded as accepted-defaults (not as a review).
    const auto = store.propose('p2', proposal({ origin: 'auto', proposedBy: 'system', migrated: true }), AT);
    assert.equal(store.load('p2').migrated, true);
    assert.equal(refusal(() => store.acceptDefaults('p2', { contentHash: '0'.repeat(64), by: 'u-admin' })).code, 'hash-mismatch');
    const accepted = store.acceptDefaults('p2', { contentHash: auto.contentHash, by: 'u-admin', acknowledgedEnforcementHash: auto.contentHash }, AT);
    assert.equal(accepted.status, 'approved');
    assert.equal(accepted.decision, 'accepted-defaults');
    assert.equal(store.effective('p2')?.version, 1);

    // Migrated, but a person replaced the auto proposal: refused.
    store.propose('p3', proposal({ origin: 'auto', proposedBy: 'system', migrated: true }), AT);
    const edited = store.propose('p3', proposal({ origin: 'user', baseVersion: 1 }), AT);
    assert.equal(refusal(() => store.acceptDefaults('p3', { contentHash: edited.contentHash, by: 'u-admin', acknowledgedEnforcementHash: edited.contentHash })).code, 'not-acceptable');
  });

  it('`migrated` is only honoured for the very first version', () => {
    store.propose(P, proposal(), AT);
    store.propose(P, proposal({ baseVersion: 1, migrated: true }), AT);
    assert.equal(store.load(P).migrated, false);
  });

  it(`refuses version ${MAX_STANDARDS_VERSIONS + 1}`, () => {
    // Seed the file directly: 200 atomic writes are slow, and the cap is what is under test.
    const first = store.propose(P, proposal(), AT);
    const versions = Array.from({ length: MAX_STANDARDS_VERSIONS }, (_, i) => ({
      ...first, version: i + 1, status: i === MAX_STANDARDS_VERSIONS - 1 ? 'pending' : 'superseded', baseVersion: i === 0 ? null : i,
    }));
    fs.writeFileSync(store.filePath(P), JSON.stringify({ schemaVersion: 1, migrated: false, versions }));
    assert.equal(store.load(P).versions.length, MAX_STANDARDS_VERSIONS);
    assert.equal(refusal(() => store.propose(P, proposal({ baseVersion: MAX_STANDARDS_VERSIONS }))).code, 'too-many-versions');
    assert.equal(store.load(P).versions.length, MAX_STANDARDS_VERSIONS);
  });

  it('an unsupported schemaVersion, invalid JSON and a malformed record all throw rather than read as empty', () => {
    const file = store.filePath(P);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, migrated: false, versions: [] }));
    assert.throws(() => store.load(P), /unsupported format/);
    assert.throws(() => store.effective(P), /unsupported format/);
    assert.throws(() => store.propose(P, proposal()), /unsupported format/);
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => store.pending(P), /not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, migrated: false, versions: [{ version: 'one' }] }));
    assert.throws(() => store.load(P), /malformed version record/);
  });

  it('writes are atomic (no temp file left behind) and owner-only where the platform has modes', () => {
    store.propose(P, proposal(), AT);
    const projectDir = path.dirname(store.filePath(P));
    assert.deepEqual(fs.readdirSync(projectDir), ['standards.json']);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(store.filePath(P)).mode & 0o777, 0o600);
    }
  });
});

// The project list is polled, and every poll asks every project where it stands.
describe('server standards store — reads are cached per project', () => {
  let dir: string;
  let store: StandardsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stdcache-'));
    store = new StandardsStore(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** Rewrite the file behind the store's back, the way a restore or a hand edit would. */
  function rewrite(projectId: string, change: (doc: { migrated: boolean; versions: StandardsVersionRecord[] }) => void): void {
    const file = store.filePath(projectId);
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    change(doc);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    // Make the change visible even on a file system with coarse timestamps.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
  }

  it('a hundred polls of a project with a long history parse its file once', () => {
    let latest: number | null = null;
    for (let n = 0; n < 12; n++) {
      latest = store.propose(P, proposal({ baseVersion: latest }), AT).version;
    }
    const fresh = new StandardsStore(dir);
    for (let poll = 0; poll < 100; poll++) {
      assert.equal(fresh.load(P).versions.length, 12);
      assert.equal(fresh.pending(P)?.version, 12);
      assert.equal(fresh.effective(P), null);
      assert.equal(fresh.get(P, 3)?.status, 'superseded');
    }
    assert.equal(fresh.parseCount, 1);
  });

  it('every write through the store is seen by the next read, without a parse', () => {
    const v1 = store.propose(P, proposal(), AT);
    assert.equal(store.load(P).versions[0].status, 'pending');
    store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    assert.equal(store.load(P).versions[0].status, 'approved');
    assert.equal(store.effective(P)?.version, 1);
    const v2 = store.propose(P, proposal({ baseVersion: 1 }), AT);
    assert.deepEqual(store.load(P).versions.map((v) => v.status), ['approved', 'pending']);
    store.reject(P, 2, { reason: 'not yet', by: 'u-rev' }, AT);
    assert.deepEqual(store.load(P).versions.map((v) => v.status), ['approved', 'rejected']);
    assert.equal(v2.version, 2);
    assert.equal(store.parseCount, 0, 'what the store wrote, it already knows');
    // And what is cached is what is on disk.
    assert.deepEqual(new StandardsStore(dir).load(P), store.load(P));
  });

  it('a refused write changes nothing a later read can see', () => {
    store.propose(P, proposal(), AT);
    refusal(() => store.propose(P, proposal({ baseVersion: null }), AT));
    refusal(() => store.approve(P, 1, { contentHash: 'f'.repeat(64), by: 'u-rev' }, AT));
    assert.deepEqual(store.load(P).versions.map((v) => [v.version, v.status]), [[1, 'pending']]);
  });

  it('a file changed, removed or broken behind the store is read again, never trusted from memory', () => {
    const v1 = store.propose(P, proposal(), AT);
    store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    assert.equal(store.effective(P)?.version, 1);

    rewrite(P, (doc) => { doc.versions[0].status = 'rejected'; });
    assert.equal(store.effective(P), null, 'the approval is gone from the file, so it is gone from the answer');
    assert.equal(store.load(P).versions[0].status, 'rejected');

    fs.writeFileSync(store.filePath(P), '{ not json');
    assert.throws(() => store.load(P), /standards\.json for project p1 is not valid JSON/);
    assert.throws(() => store.effective(P), /not valid JSON/, 'a broken file is not papered over by an older cached copy');

    fs.rmSync(store.filePath(P));
    assert.deepEqual(store.load(P), { migrated: false, versions: [] });
    assert.equal(store.exists(P), false);
  });

  it('what load returns is shared and frozen; get, effective and pending hand out copies', () => {
    const v1 = store.propose(P, proposal(), AT);
    const history = store.load(P);
    assert.equal(store.load(P), history, 'the same object: nothing was copied or parsed');
    assert.ok(Object.isFrozen(history) && Object.isFrozen(history.versions) && Object.isFrozen(history.versions[0].profile.commands));
    assert.throws(() => { (history.versions[0] as StandardsVersionRecord).status = 'approved'; }, TypeError);
    assert.throws(() => { (history.versions as StandardsVersionRecord[]).push(v1); }, TypeError);

    const copy = store.get(P, 1)!;
    copy.status = 'approved';
    copy.profile.commands.push({ label: 'x', run: 'x' });
    assert.equal(store.pending(P)?.status, 'pending');
    assert.equal(store.load(P).versions[0].profile.commands.length, sampleProfile().commands.length);
  });

  it('projects do not share a cache entry', () => {
    store.propose('p1', proposal(), AT);
    store.propose('p2', proposal({ proposedBy: 'u-other' }), AT);
    assert.equal(store.load('p1').versions[0].proposedBy, 'u-po');
    assert.equal(store.load('p2').versions[0].proposedBy, 'u-other');
    assert.deepEqual(store.load('p3'), { migrated: false, versions: [] });
  });
});

// A change is measured against what is in effect, never against the proposal it was typed on top of.
describe('server standards store — inEffectBefore', () => {
  let dir: string;
  let store: StandardsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stdstore-effect-'));
    store = new StandardsStore(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const withText = (freeText: string): ProposeInput['profile'] => ({ ...sampleProfile(), freeText });

  it('is null while nothing is approved, whatever has been proposed, rejected or superseded', () => {
    assert.equal(inEffectBefore([], { version: 1 }), null);
    const v1 = store.propose(P, proposal(), AT);
    assert.equal(inEffectBefore(store.load(P).versions, v1), null);
    const v2 = store.propose(P, proposal({ profile: withText('two'), baseVersion: 1 }), AT);
    store.reject(P, 2, { reason: 'no', by: 'u-rev' }, AT);
    const v3 = store.propose(P, proposal({ profile: withText('three'), baseVersion: 2 }), AT);
    for (const v of [v1, v2, v3]) { assert.equal(inEffectBefore(store.load(P).versions, v), null, `v${v.version}`); }
  });

  it('is the latest approved version below the one asked about — never the version itself, never a mere proposal', () => {
    const v1 = store.propose(P, proposal(), AT);
    store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v1.contentHash }, AT);
    store.propose(P, proposal({ profile: withText('two'), baseVersion: 1 }), AT);
    const v3 = store.propose(P, proposal({ profile: withText('three'), baseVersion: 2 }), AT);
    const before = store.load(P).versions;
    assert.equal(v3.baseVersion, 2);
    assert.equal(inEffectBefore(before, v3)?.version, 1, 'the superseded v2 was never in effect');
    assert.equal(inEffectBefore(before, { version: 2 })?.version, 1);
    assert.equal(inEffectBefore(before, { version: 1 }), null);

    store.approve(P, 3, { contentHash: v3.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v3.contentHash }, AT);
    const after = store.load(P).versions;
    assert.equal(inEffectBefore(after, v3)?.version, 1, 'once approved, v3 is still described by what it replaced');
    assert.equal(inEffectBefore(after, { version: 4 })?.version, 3);
  });
});

// A change to what can stop a release must never reach effect unseen. The review screen's
// diff, the acknowledgement an approval must carry and the audit flag all come from
// `enforcementReview`, which measures a version against what is IN FORCE — never against the
// proposal it happened to be written on top of — and never tries to tell a tightening from a
// loosening: any difference in the commands, a severity or the required directories counts.
describe('server standards store — enforcement-changed: any difference, measured against what is in force', () => {
  let dir: string;
  let store: StandardsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stdstore-enf-'));
    store = new StandardsStore(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const LINT = { label: 'Lint', run: 'npm run lint' };
  const TEST = { label: 'Test', run: 'npm test' };
  type Profile = ReturnType<typeof sampleProfile>;
  /** v1: two commands, two required directories, one promoted rule. */
  const base = (over: (p: Profile) => void = () => undefined, freeText = ''): Profile => {
    const p = sampleProfile();
    p.structure.requiredDirs = ['src', 'test'];
    p.commands = [{ ...LINT }, { ...TEST }];
    p.severity = { 'naming/files': 'blocking' };
    p.freeText = freeText;
    over(p);
    return p;
  };
  const propose = (profile: Profile, baseVersion: number | null): StandardsVersionRecord =>
    store.propose(P, proposal({ profile, baseVersion }), AT);
  /** Approve with the acknowledgement a reviewer gives by ticking the enforcement diff. */
  const approve = (v: StandardsVersionRecord): StandardsVersionRecord =>
    store.approve(P, v.version, { contentHash: v.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v.contentHash }, AT);
  const review = (v: StandardsVersionRecord) => enforcementReview(store.load(P).versions, v);
  const audited = (v: StandardsVersionRecord) => standardsChangeAudit(store, P, v);

  /** Every edit the closing decision names, and a few more. Each must be flagged and need an acknowledgement. */
  const EDITS: Array<{ name: string; edit: (p: Profile) => void; fields: string[]; flags: string[] }> = [
    { name: 'remove a command', edit: (p) => { p.commands = [{ ...TEST }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'rewrite a command to "|| true"', edit: (p) => { p.commands = [{ ...LINT }, { label: 'Test', run: 'npm test || true' }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'rewrite a command to an echo', edit: (p) => { p.commands = [{ label: 'Lint', run: 'echo npm run lint' }, { ...TEST }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'rename a command label', edit: (p) => { p.commands = [{ label: 'Lint (soft)', run: 'npm run lint' }, { ...TEST }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'reorder the commands', edit: (p) => { p.commands = [{ ...TEST }, { ...LINT }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'add a command', edit: (p) => { p.commands = [{ ...LINT }, { ...TEST }, { label: 'Types', run: 'npx tsc --noEmit' }]; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'empty the command list', edit: (p) => { p.commands = []; }, fields: ['commands'], flags: ['enforcement-changed', 'commands-changed'] },
    { name: 'swap a required directory', edit: (p) => { p.structure.requiredDirs = ['src', 'tmp']; }, fields: ['requiredDirs'], flags: ['enforcement-changed'] },
    { name: 'empty the required directories', edit: (p) => { p.structure.requiredDirs = []; }, fields: ['requiredDirs'], flags: ['enforcement-changed'] },
    { name: 'reorder the required directories', edit: (p) => { p.structure.requiredDirs = ['test', 'src']; }, fields: ['requiredDirs'], flags: ['enforcement-changed'] },
    { name: 'demote a rule', edit: (p) => { delete p.severity; }, fields: ['severity'], flags: ['enforcement-changed', 'severity-changed'] },
    { name: 'promote a rule', edit: (p) => { p.severity = { 'naming/files': 'blocking', 'layering/imports': 'blocking' }; }, fields: ['severity'], flags: ['enforcement-changed', 'severity-changed'] },
    { name: 'empty the settings of a promoted rule', edit: (p) => { p.naming.files = []; }, fields: ['ruleConfig'], flags: ['enforcement-changed'] },
    {
      name: 'everything at once', edit: (p) => { p.commands = []; p.structure.requiredDirs = []; delete p.severity; },
      fields: ['commands', 'severity', 'requiredDirs'], flags: ['enforcement-changed', 'severity-changed', 'commands-changed'],
    },
  ];

  for (const { name, edit, fields, flags } of EDITS) {
    it(`${name}: flagged, shown with before and after, and refused approval without the acknowledgement`, () => {
      const v1 = approve(propose(base(), null));
      const v2 = propose(base(edit, 'two'), 1);

      const r = review(v2);
      assert.equal(r.comparedTo, 1);
      assert.equal(r.changed, true);
      assert.deepEqual(r.fields, fields);
      if (fields.includes('commands')) { assert.deepEqual(r.commands, { before: v1.profile.commands, after: v2.profile.commands }); }
      if (fields.includes('requiredDirs')) { assert.deepEqual(r.requiredDirs, { before: ['src', 'test'], after: v2.profile.structure.requiredDirs }); }

      const audit = audited(v2);
      assert.deepEqual(audit.flags, flags);
      assert.equal(audit.flags[0], 'enforcement-changed', 'the invariant flag, whatever else is said');
      assert.equal(audit.after.enforcementChanged?.comparedTo, 1);
      assert.deepEqual(Object.keys(audit.after.enforcementChanged ?? {}).filter((k) => k !== 'comparedTo'), fields, 'a before/after for each differing field, and only those');

      // No acknowledgement, the wrong one, or a stale one: refused, and nothing is written.
      const before = fs.readFileSync(store.filePath(P), 'utf-8');
      for (const acknowledged of [undefined, v1.contentHash, 'f'.repeat(64), '']) {
        const err = refusal(() => store.approve(P, 2, { contentHash: v2.contentHash, by: 'u-rev', acknowledgedEnforcementHash: acknowledged }, AT));
        assert.equal(err.code, 'acknowledgement-required', String(acknowledged));
        assert.deepEqual(err.details, { fields, comparedTo: 1 });
        assert.match(err.message, /changes what can stop a release/);
      }
      assert.equal(fs.readFileSync(store.filePath(P), 'utf-8'), before, 'a refused approval writes nothing');
      assert.equal(store.effective(P)?.version, 1);

      // With it, the approval goes through — and the approval's own audit entry is flagged the same way.
      const approved = approve(v2);
      assert.equal(approved.status, 'approved');
      assert.deepEqual(audited(approved).flags, flags, 'measured against the version it replaced, not against itself');
    });
  }

  it('a version that changes nothing about enforcement is not flagged and needs no acknowledgement', () => {
    approve(propose(base(), null));
    const v2 = propose(base((p) => { p.freeText = 'Prefer smaller modules.'; p.naming.notes = 'x'; p.comments.bannedPhrases = ['todo later']; }), 1);
    assert.deepEqual(review(v2), { comparedTo: 1, commands: null, severity: [], requiredDirs: null, ruleConfig: [], fields: [], changed: false });
    assert.deepEqual(audited(v2), { after: {}, flags: [] });
    assert.equal(store.approve(P, 2, { contentHash: v2.contentHash, by: 'u-rev' }, AT).status, 'approved');
  });

  it('a first version is flagged against an empty baseline, and is not approved without the acknowledgement either', () => {
    const v1 = propose(base(), null);
    const r = review(v1);
    assert.equal(r.comparedTo, null);
    assert.deepEqual(r.fields, ['commands', 'severity', 'requiredDirs', 'ruleConfig'], 'the promoted rule arrives with its settings');
    assert.deepEqual(r.commands, { before: [], after: [LINT, TEST] });
    assert.deepEqual(r.requiredDirs, { before: [], after: ['src', 'test'] });
    assert.deepEqual(r.severity, [{ rule: 'naming/files', from: 'advisory', to: 'blocking' }]);
    assert.deepEqual(audited(v1).flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);
    assert.equal(refusal(() => store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev' }, AT)).code, 'acknowledgement-required');
    assert.equal(approve(v1).status, 'approved');
  });

  it('a first version that brings nothing enforceable is not flagged', () => {
    const bare = base((p) => { p.commands = []; p.structure.requiredDirs = []; delete p.severity; });
    const v1 = propose(bare, null);
    assert.equal(review(v1).changed, false);
    assert.deepEqual(audited(v1), { after: {}, flags: [] });
    assert.equal(store.approve(P, 1, { contentHash: v1.contentHash, by: 'u-rev' }, AT).status, 'approved');
  });

  it('the superseded chain: a change made in v2 and carried along under word edits is still a change at v3, v4 and at approval', () => {
    approve(propose(base(), null));
    const neutered = (text: string): Profile => base((p) => { p.commands = [{ label: 'Lint', run: 'npm run lint || true' }, { ...TEST }]; }, text);
    const v2 = propose(neutered('two'), 1);
    const v3 = propose(neutered('three'), 2);
    const v4 = propose(neutered('four'), 3);
    assert.deepEqual(store.load(P).versions.map((v) => [v.version, v.status, v.baseVersion]),
      [[1, 'approved', null], [2, 'superseded', 1], [3, 'superseded', 2], [4, 'pending', 3]]);
    for (const v of [v2, v3, v4]) {
      assert.deepEqual(audited(v).flags, ['enforcement-changed', 'commands-changed'], `v${v.version}`);
      assert.equal(review(v).comparedTo, 1, `v${v.version}`);
      assert.deepEqual(review(v).commands?.before, [LINT, TEST], `v${v.version}`);
    }
    // Measured against its immediate base, v4 changes nothing — exactly what must not be used.
    assert.deepEqual(enforcementFieldsChanged(enforcementChangesBetween(v3.profile, v4.profile)), []);
    assert.equal(refusal(() => store.approve(P, 4, { contentHash: v4.contentHash, by: 'u-rev' }, AT)).code, 'acknowledgement-required',
      'the word edit on top does not launder the change');
    assert.deepEqual(audited(approve(v4)).flags, ['enforcement-changed', 'commands-changed'], 'the approval that puts it into effect');
  });

  it('a rejected proposal in the chain is no reference either', () => {
    approve(propose(base(), null));
    const emptied = (text: string): Profile => base((p) => { p.structure.requiredDirs = []; }, text);
    propose(emptied('two'), 1);
    store.reject(P, 2, { reason: 'no', by: 'u-rev' }, AT);
    const v3 = propose(emptied('three'), 2);
    assert.equal(v3.baseVersion, 2);
    assert.deepEqual(audited(v3).flags, ['enforcement-changed']);
    assert.deepEqual(audited(v3).after.enforcementChanged, { comparedTo: 1, requiredDirs: { before: ['src', 'test'], after: [] } });
  });

  it('a version that puts back what is in force is not flagged, whatever it was proposed on top of', () => {
    approve(propose(base(), null));
    propose(base((p) => { p.commands = []; }, 'two'), 1);
    // v3 restores the commands: against v1 nothing changes, though against v2 two commands are added.
    const v3 = propose(base(undefined, 'three'), 2);
    assert.deepEqual(audited(v3), { after: {}, flags: [] });
    assert.equal(store.approve(P, 3, { contentHash: v3.contentHash, by: 'u-rev' }, AT).status, 'approved');
  });

  it('rejecting never needs an acknowledgement: it puts nothing into effect', () => {
    approve(propose(base(), null));
    propose(base((p) => { p.commands = []; }, 'two'), 1);
    assert.equal(store.reject(P, 2, { reason: 'keeps no test', by: 'u-rev' }, AT).status, 'rejected');
  });

  it('accepting the defaults of a migrated project needs the acknowledgement too', () => {
    const auto = store.propose(P, proposal({ profile: base(), origin: 'auto', proposedBy: 'system', migrated: true }), AT);
    assert.equal(refusal(() => store.acceptDefaults(P, { contentHash: auto.contentHash, by: 'u-admin' }, AT)).code, 'acknowledgement-required');
    assert.equal(store.pending(P)?.status, 'pending', 'nothing was put into effect');
    const accepted = store.acceptDefaults(P, { contentHash: auto.contentHash, by: 'u-admin', acknowledgedEnforcementHash: auto.contentHash }, AT);
    assert.deepEqual([accepted.status, accepted.decision], ['approved', 'accepted-defaults']);
  });

  it('the content hash is still checked first: an acknowledgement of other content approves nothing', () => {
    approve(propose(base(), null));
    const v2 = propose(base((p) => { p.commands = []; }, 'two'), 1);
    const other = 'e'.repeat(64);
    assert.equal(refusal(() => store.approve(P, 2, { contentHash: other, by: 'u-rev', acknowledgedEnforcementHash: other }, AT)).code, 'hash-mismatch');
    assert.equal(store.pending(P)?.version, v2.version);
  });

  it('severityReview is the severity part of the same comparison', () => {
    approve(propose(base(), null));
    const v2 = propose(base((p) => { delete p.severity; p.commands = []; }, 'two'), 1);
    assert.deepEqual(severityReview(store.load(P).versions, v2), { comparedTo: 1, changes: [{ rule: 'naming/files', from: 'blocking', to: 'advisory' }] });
    assert.deepEqual(severityReview(store.load(P).versions, v2).changes, review(v2).severity);
    // Against the defaults — what an unreadable store would leave to compare with — the demotion does not show.
    assert.deepEqual(severityChangesBetween(null, v2.profile), []);
  });

  it('fails closed: with a store that cannot be read the entry is flagged as an unverified enforcement change', () => {
    approve(propose(base(), null));
    // v2 strips everything: against an empty baseline it looks like no change at all.
    const v2 = propose(base((p) => { p.commands = []; p.structure.requiredDirs = []; delete p.severity; }, 'two'), 1);
    fs.writeFileSync(store.filePath(P), '{ not json');
    assert.throws(() => store.load(P));
    const audit = audited(v2);
    assert.deepEqual(audit.flags, ['enforcement-changed', 'enforcement-reference-unreadable'], 'which is why the flag must not depend on it');
    assert.deepEqual(audit.after, { enforcementChanged: { comparedTo: null } });
  });

  it('the audit payload passes the audit log\'s own secret-key filter, commands and settings included', () => {
    approve(propose(base(), null));
    const v2 = propose(base((p) => { p.commands = []; p.naming.files = []; p.structure.requiredDirs = []; delete p.severity; }, 'two'), 1);
    const log = new AuditLog(dir);
    assert.doesNotThrow(() => log.append({
      actorUserId: 'u', actorUsername: 'u', action: 'standards.propose', projectId: P, target: 'standards v2',
      after: audited(v2).after, flags: audited(v2).flags,
    }));
  });
});

// ─── Design system changes: acknowledged and audited like enforcement, never logging prose ───

describe('server standards store — design-changed', () => {
  let dir: string;
  let store: StandardsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-stdstore-design-'));
    store = new StandardsStore(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  type Profile = ReturnType<typeof sampleProfile>;
  const DOC_SECRET_PROSE = 'Use the brand gradient only on the landing hero.';
  const withDesign = (over: (p: Profile) => void = () => undefined): Profile => {
    const p = sampleProfile();
    p.design = { ...templateDesign('node-ts', '')!, doc: `# Design\n\n${DOC_SECRET_PROSE}\n` };
    over(p);
    return p;
  };
  const propose = (profile: Profile, baseVersion: number | null): StandardsVersionRecord =>
    store.propose(P, proposal({ profile, baseVersion }), AT);
  const approveAck = (v: StandardsVersionRecord): StandardsVersionRecord =>
    store.approve(P, v.version, { contentHash: v.contentHash, by: 'u-rev', acknowledgedEnforcementHash: v.contentHash }, AT);
  const approveBare = (v: StandardsVersionRecord): StandardsVersionRecord =>
    store.approve(P, v.version, { contentHash: v.contentHash, by: 'u-rev' }, AT);

  it('a pending version whose design differs from the one in effect needs the acknowledgement, with fields ["design"]', () => {
    approveAck(propose(withDesign(), null));
    const v2 = propose(withDesign((p) => { p.design!.tokens = p.design!.tokens.replace('#0969da', '#8250df'); }), 1);
    const err = refusal(() => approveBare(v2));
    assert.equal(err.code, 'acknowledgement-required');
    assert.deepEqual(err.details, { fields: ['design'], comparedTo: 1 });
    assert.match(err.message, /^Standards v2 changes the design system\. Review the changes/);
    assert.equal(store.effective(P)?.version, 1);
    assert.equal(approveAck(v2).status, 'approved');
  });

  it('removing the design needs the acknowledgement too', () => {
    approveAck(propose(withDesign(), null));
    const v2 = propose(withDesign((p) => { delete p.design; }), 1);
    const r = designReview(store.load(P).versions, v2);
    assert.equal(r.changed, true);
    assert.ok(r.tokens.every((t) => t.after === null));
    assert.equal(refusal(() => approveBare(v2)).code, 'acknowledgement-required');
  });

  it('an unchanged design and unchanged enforcement need no acknowledgement', () => {
    approveAck(propose(withDesign(), null));
    const v2 = propose(withDesign((p) => { p.freeText = 'Prefer smaller modules.'; }), 1);
    assert.equal(designReview(store.load(P).versions, v2).changed, false);
    assert.deepEqual(standardsChangeAudit(store, P, v2), { after: {}, flags: [] });
    assert.equal(approveBare(v2).status, 'approved');
  });

  it('accepting the defaults of a migrated project with a design needs the acknowledgement', () => {
    const bare = withDesign((p) => { p.commands = []; p.structure.requiredDirs = []; });
    const auto = store.propose(P, proposal({ profile: bare, origin: 'auto', proposedBy: 'system', migrated: true }), AT);
    assert.equal(enforcementReview(store.load(P).versions, auto).changed, false, 'nothing enforceable: only the design changes');
    const err = refusal(() => store.acceptDefaults(P, { contentHash: auto.contentHash, by: 'u-admin' }, AT));
    assert.deepEqual(err.details, { fields: ['design'], comparedTo: null });
    assert.equal(store.acceptDefaults(P, { contentHash: auto.contentHash, by: 'u-admin', acknowledgedEnforcementHash: auto.contentHash }, AT).status, 'approved');
  });

  it('the audit carries design-changed and the token diff, never the DESIGN.md text', () => {
    approveAck(propose(withDesign(), null));
    const v2 = propose(withDesign((p) => {
      p.design!.tokensPath = 'src/theme.css';
      p.design!.tokens = p.design!.tokens.replace('#0969da', '#8250df');
      p.design!.doc = `# Design\n\n${DOC_SECRET_PROSE} Also on the pricing page.\n`;
    }), 1);
    const audit = standardsChangeAudit(store, P, v2);
    assert.deepEqual(audit.flags, ['design-changed']);
    assert.equal(audit.after.enforcementChanged, undefined, 'an advisory design rule is not an enforcement change');
    assert.deepEqual(audit.after.designChanged?.values, [{ name: '--color-primary', before: '#0969da', after: '#8250df' }]);
    assert.equal(audit.after.designChanged?.docChanged, true);
    assert.equal(audit.after.designChanged?.docSectionsChanged, 1);
    assert.deepEqual(audit.after.designChanged?.files, {
      before: { doc: 'docs/design/DESIGN.md', values: 'src/styles/tokens.css' }, after: { doc: 'docs/design/DESIGN.md', values: 'src/theme.css' },
    });
    assert.equal(JSON.stringify(audit.after).includes(DOC_SECRET_PROSE), false, 'no DESIGN.md prose in the audit log');
    assert.doesNotThrow(() => new AuditLog(dir).append({
      actorUserId: 'u', actorUsername: 'u', action: 'standards.propose', projectId: P, target: 'standards v2', after: audit.after, flags: audit.flags,
    }));
  });

  it('enforcement-changed appears for a design change only while the design rule is blocking on either side', () => {
    approveAck(propose(withDesign((p) => { p.severity = { 'frontend/design-tokens': 'blocking' }; }), null));
    const v2 = propose(withDesign((p) => {
      p.severity = { 'frontend/design-tokens': 'blocking' };
      p.design!.tokens = p.design!.tokens.replace('#0969da', '#8250df');
    }), 1);
    const audit = standardsChangeAudit(store, P, v2);
    assert.deepEqual(audit.flags, ['enforcement-changed', 'design-changed']);
    const ruleConfig = audit.after.enforcementChanged?.ruleConfig ?? [];
    assert.deepEqual(ruleConfig.map((c) => c.rule), ['frontend/design-tokens']);
    assert.equal(JSON.stringify(ruleConfig).includes(DOC_SECRET_PROSE), false, 'hashes only');
    assert.deepEqual(refusal(() => approveBare(v2)).details, { fields: ['ruleConfig', 'design'], comparedTo: 1 });
    // The audit log's own secret-key filter accepts the entry: the fingerprint has no token-shaped key.
    assert.doesNotThrow(() => new AuditLog(dir).append({
      actorUserId: 'u', actorUsername: 'u', action: 'standards.propose', projectId: P, target: 'standards v2', after: audit.after, flags: audit.flags,
    }));
  });

  it('fails closed with the design measured against nothing', () => {
    approveAck(propose(withDesign(), null));
    const v2 = propose(withDesign((p) => { p.freeText = 'x'; }), 1);
    fs.writeFileSync(store.filePath(P), '{ not json');
    const audit = standardsChangeAudit(store, P, v2);
    assert.ok(audit.flags.includes('enforcement-reference-unreadable'));
    assert.ok(audit.flags.includes('design-changed'));
    assert.equal(audit.after.designChanged?.comparedTo, null);
  });

  it('a store file written by the current build (no design, no provenance design) loads', () => {
    const v1 = propose(sampleProfile(), null);
    const raw = JSON.parse(fs.readFileSync(store.filePath(P), 'utf-8')) as { versions: Array<{ profile: Record<string, unknown>; provenance: Record<string, unknown> }> };
    assert.equal('design' in raw.versions[0].profile, false);
    assert.equal('design' in raw.versions[0].provenance, false);
    const reread = new StandardsStore(dir);
    assert.equal(reread.get(P, 1)?.contentHash, v1.contentHash);
  });
});
