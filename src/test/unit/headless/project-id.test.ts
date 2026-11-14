// ─── project-id: the closed reason set and the rule a project key must pass to be sent ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  cachedResolution, createReasonedIdentityCache, DeadlineOutcome, IdentityAbsenceReason, isProjectIdReason, PROJECT_ID_DEADLINE_MS,
  PROJECT_ID_REASON_PHRASES, PROJECT_ID_REASONS, projectIdAsSent, projectIdScrubContext, projectSegmentModel, resolveFolderIdentity,
  resolveWithDeadline,
} from '../../../headless/project-id';
import { REVOKED_MESSAGE, RUN_META_URL_MAX } from '../../../headless/onosoo-relay';
import type { ProjectIdentity, ProjectIdentityResolution } from '../../../headless/project-identity';
import { createRedactor, Redactor } from '../../../utils/redact';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const ROOT = 'root:' + 'a'.repeat(40);
const MULTI = 'multi:' + 'f'.repeat(64);

describe('project-id — reasons', () => {
  it('is a closed set of seven, each with a phrase', () => {
    assert.deepEqual([...PROJECT_ID_REASONS], ['no_folder', 'not_a_repo', 'git_unreadable', 'no_commits', 'shallow_no_origin', 'not_sent', 'timeout']);
    for (const r of PROJECT_ID_REASONS) {
      assert.equal(typeof PROJECT_ID_REASON_PHRASES[r], 'string', r);
      assert.ok(PROJECT_ID_REASON_PHRASES[r].length > 0, r);
    }
    assert.deepEqual(Object.keys(PROJECT_ID_REASON_PHRASES).sort(), [...PROJECT_ID_REASONS].sort());
  });

  it('uses the spec phrases', () => {
    assert.equal(PROJECT_ID_REASON_PHRASES.not_a_repo, 'not a git repository, or git is not available');
    assert.equal(PROJECT_ID_REASON_PHRASES.git_unreadable, 'git could not read this repository');
    assert.equal(PROJECT_ID_REASON_PHRASES.no_commits, 'no usable origin remote and no commits yet');
    assert.equal(PROJECT_ID_REASON_PHRASES.shallow_no_origin, 'shallow clone with no usable origin remote');
    assert.equal(PROJECT_ID_REASON_PHRASES.not_sent, 'its ID would not be sent to ONOSOO');
    assert.equal(PROJECT_ID_REASON_PHRASES.timeout, 'could not resolve in time');
    assert.equal(PROJECT_ID_REASON_PHRASES.no_folder, 'no folder is open');
  });

  it('isProjectIdReason accepts members only', () => {
    for (const r of PROJECT_ID_REASONS) { assert.equal(isProjectIdReason(r), true); }
    for (const v of ['foo', '', null, undefined, 1, {}]) { assert.equal(isProjectIdReason(v), false); }
  });

  it('names a deadline longer than a run start waits', () => {
    assert.equal(PROJECT_ID_DEADLINE_MS, 10_000);
  });
});

describe('project-id — projectIdAsSent', () => {
  const cwd = tmp('moag-pid-ws-');
  const ctx = { redactor: createRedactor([]), cwd };

  it('accepts git:, root: and multi: keys', () => {
    assert.deepEqual(projectIdAsSent({ project_key: 'git:github.com/o/r', repo_url: 'https://github.com/o/r' }, ctx),
      { ok: true, project_key: 'git:github.com/o/r', repo_url: 'https://github.com/o/r' });
    assert.deepEqual(projectIdAsSent({ project_key: ROOT }, ctx), { ok: true, project_key: ROOT, repo_url: null });
    assert.deepEqual(projectIdAsSent({ project_key: MULTI, repos: [{ dir: 'a', key: ROOT }] }, ctx), { ok: true, project_key: MULTI, repo_url: null });
  });

  it('a root: or multi: key never carries a repo_url', () => {
    const r = projectIdAsSent({ project_key: ROOT, repo_url: 'https://github.com/o/r' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.ok && r.repo_url, null);
    const m = projectIdAsSent({ project_key: MULTI, repo_url: 'https://github.com/o/r' }, ctx);
    assert.equal(m.ok && m.repo_url, null);
  });

  it('drops an http URL, a URL over the cap and a local path URL, keeping the key', () => {
    for (const url of ['http://github.com/o/r', 'https://github.com/' + 'u'.repeat(RUN_META_URL_MAX), path.join(cwd, 'r.git')]) {
      const r = projectIdAsSent({ project_key: 'git:github.com/o/r', repo_url: url }, ctx);
      assert.deepEqual(r, { ok: true, project_key: 'git:github.com/o/r', repo_url: null }, url);
    }
  });

  it('refuses an empty, too long, unknown-prefix or non-string key', () => {
    for (const k of ['', 'git:github.com/' + 'k'.repeat(300), 'svn:x/y', 'name:proj']) {
      assert.deepEqual(projectIdAsSent({ project_key: k }, ctx), { ok: false, reason: 'not_sent' }, k);
    }
    assert.deepEqual(projectIdAsSent({ project_key: 42 } as unknown as { project_key: string }, ctx), { ok: false, reason: 'not_sent' });
    assert.deepEqual(projectIdAsSent(null as unknown as { project_key: string }, ctx), { ok: false, reason: 'not_sent' });
  });

  it('refuses a key that contains the workspace path', () => {
    assert.deepEqual(projectIdAsSent({ project_key: 'git:' + path.join(cwd, 'x') }, ctx), { ok: false, reason: 'not_sent' });
  });

  it('a throwing redactor means not_sent, never a throw', () => {
    const throwing: Redactor = { redact: () => { throw new Error('nope'); } };
    assert.deepEqual(projectIdAsSent({ project_key: 'git:github.com/o/r' }, { redactor: throwing, cwd }), { ok: false, reason: 'not_sent' });
  });
});

describe('project-id — projectIdScrubContext', () => {
  it('a key containing a stored Anthropic key passed as an extra is not sent (criterion 6)', () => {
    const cwd = tmp('moag-pid-ws-');
    // Matches no built-in pattern, so only the exact value (the extra) can catch it.
    const stored = 'StoredAnthropicValue' + 'x'.repeat(12);
    const key = 'git:github.com/o/' + stored;
    assert.equal(projectIdAsSent({ project_key: key }, projectIdScrubContext(cwd, {}, [])).ok, true, 'without the extra it passes');
    assert.deepEqual(projectIdAsSent({ project_key: key }, projectIdScrubContext(cwd, {}, [null, stored, undefined])), { ok: false, reason: 'not_sent' });
  });

  it('redacts the engine keys in env and the workspace .env secrets', () => {
    const cwd = tmp('moag-pid-ws-');
    const envKey = 'EnvAnthropicValue' + 'E'.repeat(16);
    assert.equal(projectIdAsSent({ project_key: 'git:github.com/o/' + envKey }, projectIdScrubContext(cwd, {}, [])).ok, true);
    assert.equal(projectIdAsSent({ project_key: 'git:github.com/o/' + envKey }, projectIdScrubContext(cwd, { ANTHROPIC_API_KEY: envKey }, [])).ok, false);
    const fileSecret = 'FileSecretValue' + 'S'.repeat(16);
    assert.equal(projectIdAsSent({ project_key: 'git:github.com/o/' + fileSecret }, projectIdScrubContext(cwd, {}, [])).ok, true);
    fs.writeFileSync(path.join(cwd, '.env'), `MY_TOKEN=${fileSecret}\n`);
    assert.equal(projectIdAsSent({ project_key: 'git:github.com/o/' + fileSecret }, projectIdScrubContext(cwd, {}, [])).ok, false);
  });

  it('sets cwd to the folder', () => {
    const cwd = tmp('moag-pid-ws-');
    assert.equal(projectIdScrubContext(cwd, {}, []).cwd, cwd);
  });
});

// ─── Reasoned cache, deadline, segment model ───

describe('project-id — createReasonedIdentityCache', () => {
  it('records the reason of a null result and clears it after a later success', async () => {
    let next: ProjectIdentityResolution = { identity: null, reason: 'no_commits' };
    const rc = createReasonedIdentityCache({ resolve: async () => next, cacheOptions: { ttlMs: 0 } });
    assert.equal(await rc.cache.warm('/w/a'), null);
    assert.equal(rc.reasonOf('/w/a'), 'no_commits');
    assert.equal(rc.cache.peek('/w/a'), null);
    next = { identity: { project_key: ROOT }, reason: null };
    assert.deepEqual(await rc.cache.warm('/w/a'), { project_key: ROOT });
    assert.equal(rc.reasonOf('/w/a'), undefined);
  });

  it('a throwing or rejecting resolver is git_unreadable', async () => {
    const throwing = createReasonedIdentityCache({ resolve: () => { throw new Error('boom'); } });
    assert.equal(await throwing.cache.warm('/w/t'), null);
    assert.equal(throwing.reasonOf('/w/t'), 'git_unreadable');
    const rejecting = createReasonedIdentityCache({ resolve: () => Promise.reject(new Error('boom')) });
    assert.equal(await rejecting.cache.warm('/w/r'), null);
    assert.equal(rejecting.reasonOf('/w/r'), 'git_unreadable');
  });

  it('keeps at most maxEntries reasons, evicting the oldest', async () => {
    const rc = createReasonedIdentityCache({ resolve: async () => ({ identity: null, reason: 'not_a_repo' }), maxEntries: 2 });
    for (const d of ['/w/1', '/w/2', '/w/3']) { await rc.cache.warm(d); }
    assert.equal(rc.reasonOf('/w/1'), undefined);
    assert.equal(rc.reasonOf('/w/2'), 'not_a_repo');
    assert.equal(rc.reasonOf('/w/3'), 'not_a_repo');
  });

  it('keys reasons like the cache (the same folder written two ways)', async () => {
    const rc = createReasonedIdentityCache({ resolve: async () => ({ identity: null, reason: 'shallow_no_origin' }) });
    const dir = tmp('moag-pid-key-');
    await rc.cache.warm(dir);
    assert.equal(rc.reasonOf(path.join(dir, '.')), 'shallow_no_origin');
  });
});

describe('project-id — cachedResolution and resolveFolderIdentity', () => {
  const src = (peek: ProjectIdentity | null | undefined, reason?: 'not_a_repo') => ({
    peek: () => peek,
    reasonOf: () => reason,
    warm: sinon.stub().resolves(peek ?? null),
  });

  it('cachedResolution: never resolved, null without a reason, null with one, a value', () => {
    assert.equal(cachedResolution(src(undefined), '/w'), undefined);
    assert.equal(cachedResolution(src(null), '/w'), undefined);
    assert.deepEqual(cachedResolution(src(null, 'not_a_repo'), '/w'), { identity: null, reason: 'not_a_repo' });
    assert.deepEqual(cachedResolution(src({ project_key: ROOT }), '/w'), { identity: { project_key: ROOT }, reason: null });
  });

  it('resolveFolderIdentity: a priority warm, its reason, or a direct lookup when the reason is unknown', async () => {
    const hit = src({ project_key: ROOT });
    const direct = sinon.stub().resolves({ identity: null, reason: 'no_commits' });
    assert.deepEqual(await resolveFolderIdentity(hit, '/w', direct), { identity: { project_key: ROOT }, reason: null });
    assert.deepEqual(hit.warm.firstCall.args, ['/w', { priority: true }]);
    assert.equal(direct.called, false);
    assert.deepEqual(await resolveFolderIdentity(src(null, 'not_a_repo'), '/w', direct), { identity: null, reason: 'not_a_repo' });
    assert.equal(direct.called, false);
    assert.deepEqual(await resolveFolderIdentity(src(null), '/w', direct), { identity: null, reason: 'no_commits' });
    assert.equal(direct.callCount, 1);
    assert.deepEqual(await resolveFolderIdentity(null, '/w', direct), { identity: null, reason: 'no_commits' });
    assert.deepEqual(await resolveFolderIdentity(null, '/w', () => Promise.reject(new Error('x'))), { identity: null, reason: 'git_unreadable' });
  });
});

describe('project-id — resolveWithDeadline (fake timers)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers(); });
  afterEach(() => { clock.restore(); });

  it('a promise that never settles times out exactly at ms, not before', async () => {
    let outcome: DeadlineOutcome<number> | undefined;
    void resolveWithDeadline(new Promise<number>(() => undefined), 1000).then((o) => { outcome = o; });
    await clock.tickAsync(999);
    assert.equal(outcome, undefined);
    await clock.tickAsync(1);
    assert.deepEqual(outcome, { kind: 'timeout' });
  });

  it('resolves done once and clears its timer', async () => {
    const timers = { setTimeout: sinon.spy((fn: () => void, ms: number) => setTimeout(fn, ms)), clearTimeout: sinon.spy((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)) };
    let resolveP: (v: number) => void = () => undefined;
    const p = new Promise<number>((r) => { resolveP = r; });
    const out = resolveWithDeadline(p, 1000, { timers });
    resolveP(7);
    assert.deepEqual(await out, { kind: 'done', value: 7 });
    assert.equal(timers.clearTimeout.callCount, 1);
    await clock.tickAsync(2000);
    assert.deepEqual(await out, { kind: 'done', value: 7 });
  });

  it('a rejected promise is done with undefined, never a rejection', async () => {
    assert.deepEqual(await resolveWithDeadline(Promise.reject(new Error('x')), 1000), { kind: 'done', value: undefined });
  });

  it('abort is cancelled and removes its listener; an already-aborted signal is cancelled at once', async () => {
    const ac = new AbortController();
    const remove = sinon.spy(ac.signal, 'removeEventListener');
    const out = resolveWithDeadline(new Promise<number>(() => undefined), 1000, { signal: ac.signal });
    ac.abort();
    assert.deepEqual(await out, { kind: 'cancelled' });
    assert.equal(remove.calledWith('abort'), true);
    const pre = new AbortController();
    pre.abort();
    assert.deepEqual(await resolveWithDeadline(new Promise<number>(() => undefined), 1000, { signal: pre.signal }), { kind: 'cancelled' });
    assert.equal(clock.countTimers(), 0, 'no timer is left behind');
  });

  it('a timeout removes the abort listener too', async () => {
    const ac = new AbortController();
    const remove = sinon.spy(ac.signal, 'removeEventListener');
    const out = resolveWithDeadline(new Promise<number>(() => undefined), 50, { signal: ac.signal });
    await clock.tickAsync(50);
    assert.deepEqual(await out, { kind: 'timeout' });
    assert.equal(remove.calledWith('abort'), true);
  });
});

describe('project-id — projectSegmentModel', () => {
  const cwd = tmp('moag-pid-seg-');
  const ctx = { redactor: createRedactor([]), cwd };
  const GIT: ProjectIdentity = { project_key: 'git:github.com/o/r', repo_url: 'https://github.com/o/r' };
  const ABSENT: IdentityAbsenceReason[] = ['not_a_repo', 'git_unreadable', 'no_commits', 'shallow_no_origin'];

  it('is hidden when unpaired, whatever the identity', () => {
    assert.deepEqual(projectSegmentModel('none', undefined, null, null), { kind: 'hidden' });
    assert.deepEqual(projectSegmentModel('none', { identity: GIT, reason: null }, projectIdAsSent(GIT, ctx), null), { kind: 'hidden' });
  });

  for (const status of ['on', 'off', 'revoked'] as const) {
    describe(`status ${status}`, () => {
      it('resolving', () => {
        assert.deepEqual(projectSegmentModel(status, undefined, null, null), { kind: 'resolving', status, revokedTitle: REVOKED_MESSAGE });
      });

      it('key without a URL (root:) and with one (git:)', () => {
        const root: ProjectIdentity = { project_key: ROOT };
        assert.deepEqual(projectSegmentModel(status, { identity: root, reason: null }, projectIdAsSent(root, ctx), null),
          { kind: 'key', status, revokedTitle: REVOKED_MESSAGE, projectKey: ROOT, repoUrl: null, firstFolderName: null });
        assert.deepEqual(projectSegmentModel(status, { identity: GIT, reason: null }, projectIdAsSent(GIT, ctx), 'first'),
          { kind: 'key', status, revokedTitle: REVOKED_MESSAGE, projectKey: GIT.project_key, repoUrl: GIT.repo_url, firstFolderName: 'first' });
      });

      for (const reason of ABSENT) {
        it(`none — ${reason}`, () => {
          assert.deepEqual(projectSegmentModel(status, { identity: null, reason }, null, null),
            { kind: 'none', status, revokedTitle: REVOKED_MESSAGE, reason, phrase: PROJECT_ID_REASON_PHRASES[reason] });
        });
      }

      it('none — not_sent, and the key is nowhere in the model', () => {
        const bad: ProjectIdentity = { project_key: 'git:' + path.join(cwd, 'secret-place') };
        const m = projectSegmentModel(status, { identity: bad, reason: null }, projectIdAsSent(bad, ctx), 'first');
        assert.deepEqual(m, { kind: 'none', status, revokedTitle: REVOKED_MESSAGE, reason: 'not_sent', phrase: PROJECT_ID_REASON_PHRASES.not_sent });
        assert.ok(!JSON.stringify(m).includes('secret-place'));
        assert.ok(!JSON.stringify(m).includes(cwd.replace(/\\/g, '\\\\')));
      });
    });
  }
});
