// ─── GitHub issue-sync core: intake + completion feedback (the closed loop) ───

import { strict as assert } from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

interface GhCall { args: string[]; }

function load(ghSyncReturn: string | (() => string), capture: { sync: GhCall[]; async: GhCall[] }) {
  return proxyquire('../../../github/issue-sync', {
    '../utils/gh': {
      ghSync: (args: string[]) => {
        capture.sync.push({ args });
        return typeof ghSyncReturn === 'function' ? ghSyncReturn() : ghSyncReturn;
      },
      ghAsync: (args: string[], _opts: unknown, cb?: (e: Error | null) => void) => {
        capture.async.push({ args });
        if (cb) { cb(null); }
      },
    },
  });
}

describe('issue-sync: fetchOpenIssues', () => {
  it('parses gh JSON into typed issues', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load(JSON.stringify([{ number: 1, title: 'Bug A', body: 'x' }, { number: 2, title: 'Bug B', body: '' }]), cap);
    const issues = mod.fetchOpenIssues({ repo: 'o/r', label: 'sync' });
    assert.equal(issues.length, 2);
    assert.equal(issues[0].number, 1);
    // label flag forwarded to gh as discrete args
    assert.ok(cap.sync[0].args.includes('--label'));
    assert.ok(cap.sync[0].args.includes('sync'));
  });

  it('returns [] on malformed JSON', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load('not json', cap);
    assert.deepEqual(mod.fetchOpenIssues({ repo: 'o/r' }), []);
  });

  it('returns [] when gh throws', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load(() => { throw new Error('gh missing'); }, cap);
    assert.deepEqual(mod.fetchOpenIssues({ repo: 'o/r' }), []);
  });
});

describe('issue-sync: newIssuesToTasks', () => {
  it('converts new issues to tasks and dedups via the known set', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load('[]', cap);
    const known = new Set<string>();
    const issues = [{ number: 5, title: 'T', body: 'b' }];
    const first = mod.newIssuesToTasks(issues, 'o/r', known);
    assert.equal(first.length, 1);
    assert.equal(first[0].sourceIssueNumber, 5);
    assert.equal(first[0].sourceIssueRepo, 'o/r');
    // second pass with same issue yields nothing (already known)
    const second = mod.newIssuesToTasks(issues, 'o/r', known);
    assert.equal(second.length, 0);
  });
});

describe('issue-sync: reportIssueResult', () => {
  it('on success comments then closes the issue', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load('', cap);
    mod.reportIssueResult('o/r', 9, { success: true });
    const verbs = cap.async.map((c) => c.args.slice(0, 2).join(' '));
    assert.ok(verbs.includes('issue comment'));
    assert.ok(verbs.includes('issue close'));
  });

  it('on failure comments and applies a failure label (no close)', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load('', cap);
    mod.reportIssueResult('o/r', 9, { success: false });
    const joined = cap.async.map((c) => c.args.join(' '));
    assert.ok(joined.some((a) => a.startsWith('issue comment')));
    assert.ok(joined.some((a) => a.includes('--add-label')));
    assert.ok(!joined.some((a) => a.startsWith('issue close')));
  });
});

describe('issue-sync: fileIncidentIssue', () => {
  it('creates a labelled incident issue and returns its URL', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load('https://github.com/o/r/issues/42\n', cap);
    const url = mod.fileIncidentIssue('o/r', 'Incident: down', 'body', { label: 'moag:incident' });
    assert.equal(url, 'https://github.com/o/r/issues/42');
    const args = cap.sync[0].args;
    assert.ok(args.includes('--label') && args.includes('moag:incident'));
    assert.ok(args[0] === 'issue' && args[1] === 'create');
  });

  it('returns null when gh throws (degrades, never throws)', () => {
    const cap = { sync: [] as GhCall[], async: [] as GhCall[] };
    const mod = load(() => { throw new Error('gh missing'); }, cap);
    assert.equal(mod.fileIncidentIssue('o/r', 't', 'b'), null);
  });
});
