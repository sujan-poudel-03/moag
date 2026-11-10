// ─── Delivering a remote run's branch: push it, and open a DRAFT pull request when asked ───
//
// The unit tests drive deliverBranch with a fake git and a fake `gh`. The real-git tests use throwaway
// repositories (a bare "remote" and a project clone) to prove the rules that matter against actual git:
// only a branch under the prefix is pushed, never with force, and a repository hook does not run.

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DeliveryDeps, DeliveryRequest, GitResult, deliverBranch, deliveryBody, isDeliverableBranch, realDeliveryDeps,
} from '../../../headless/remote-delivery';
import type { PrOutcome, PrRequest } from '../../../utils/pr';

const base: DeliveryRequest = {
  mode: 'draft-pr',
  projectPath: '/p',
  branch: 'moag/notes-export-tests',
  branchPrefix: 'moag/',
  base: 'dev',
  projectName: 'ONOSOO',
  planName: 'Add tests for the notes export module',
  taskNames: ['Read the export module', 'Write tests'],
  exitCode: 0,
  runId: '11111111-2222-3333-4444-555555555555',
};

function fakes(over: { git?: (args: string[]) => GitResult; pr?: PrOutcome } = {}) {
  const gitCalls: string[][] = [];
  const prCalls: PrRequest[] = [];
  const deps: DeliveryDeps = {
    git: async (args) => { gitCalls.push(args); return over.git ? over.git(args) : { ok: true, stdout: 'ok' }; },
    openPr: (req) => { prCalls.push(req); return over.pr ?? { ok: true, url: 'https://github.com/o/r/pull/7' }; },
  };
  return { deps, gitCalls, prCalls };
}

describe('isDeliverableBranch', () => {
  it('accepts a plain branch under the prefix', () => {
    for (const b of ['moag/x', 'moag/notes-export-tests', 'moag/a/b-c_d.e', 'moag/' + 'a'.repeat(90)]) { assert.equal(isDeliverableBranch(b, 'moag/'), true, b); }
  });

  it('refuses anything else: another prefix, the bare prefix, traversal, odd characters, a lock file', () => {
    for (const b of ['main', 'dev', 'feat/x', 'moag/', 'moag', '-moag/x', 'moag/../main', 'moag//x', 'moag/x/', 'moag/x.', 'moag/x.lock',
      'moag/a b', 'moag/a~1', 'moag/a^b', 'moag/a:b', 'moag/a?b', 'moag/a*b', 'moag/a[b', 'moag/a\\b', 'moag/a@{b}', 'moag/\nx', 'moag/' + 'a'.repeat(120)]) {
      assert.equal(isDeliverableBranch(b, 'moag/'), false, JSON.stringify(b));
    }
    assert.equal(isDeliverableBranch('moag/x', ''), false, 'no prefix configured: nothing is deliverable');
  });
});

describe('deliveryBody', () => {
  it('says plainly that it is a draft and nothing was merged or deployed', () => {
    const body = deliveryBody(base);
    assert.match(body, /This is a draft\. Nothing was merged or deployed\./);
    assert.match(body, /Add tests for the notes export module/);
    assert.match(body, /- Read the export module/);
    assert.match(body, new RegExp(base.runId));
  });

  it('warns when the run did not finish cleanly, and survives odd task names', () => {
    assert.match(deliveryBody({ ...base, exitCode: 1 }), /exit code 1: read the run in ONOSOO before trusting this/);
    assert.match(deliveryBody({ ...base, exitCode: null }), /exit code unknown/);
    const body = deliveryBody({ ...base, taskNames: ['a\nb'.repeat(200)] });
    assert.ok(!/- a\nb/.test(body), 'a task name is one line');
    assert.match(deliveryBody({ ...base, taskNames: [] }), /No task names were recorded/);
  });
});

describe('deliverBranch', () => {
  it('off: does nothing at all', async () => {
    const f = fakes();
    const out = await deliverBranch({ ...base, mode: 'off' }, f.deps);
    assert.equal(out.event, null);
    assert.equal(f.gitCalls.length, 0);
    assert.equal(f.prCalls.length, 0);
  });

  it('branch: pushes exactly that branch with an explicit refspec, no force, and opens no PR', async () => {
    const f = fakes();
    const out = await deliverBranch({ ...base, mode: 'branch' }, f.deps);
    assert.equal(out.event, null);
    const push = f.gitCalls.find((a) => a[0] === 'push')!;
    assert.deepEqual(push, ['push', '--no-verify', 'origin', 'refs/heads/moag/notes-export-tests:refs/heads/moag/notes-export-tests']);
    assert.ok(!push.some((a) => /force|^-f$|\+/.test(a)), 'never forced');
    assert.equal(f.prCalls.length, 0);
  });

  it('draft-pr: pushes, then opens a DRAFT PR for the pushed branch against the configured base', async () => {
    const f = fakes();
    const out = await deliverBranch(base, f.deps);
    assert.deepEqual(out.event, { event: 'pr-created', url: 'https://github.com/o/r/pull/7' });
    assert.equal(f.prCalls.length, 1);
    const pr = f.prCalls[0];
    assert.equal(pr.draft, true);
    assert.equal(pr.head, 'moag/notes-export-tests');
    assert.equal(pr.base, 'dev');
    assert.equal(pr.cwd, '/p');
    assert.match(pr.body ?? '', /This is a draft/);
    assert.ok(f.gitCalls.findIndex((a) => a[0] === 'push') < f.gitCalls.length, 'the push happened');
  });

  it('without a base the repository default is used', async () => {
    const f = fakes();
    await deliverBranch({ ...base, base: null }, f.deps);
    assert.equal('base' in f.prCalls[0], false);
  });

  it('refuses a branch outside the prefix before it runs any git command', async () => {
    for (const branch of ['main', 'moag/../main', 'feat/x', 'moag/']) {
      const f = fakes();
      const out = await deliverBranch({ ...base, branch }, f.deps);
      assert.equal(out.event?.event, 'pr-skipped', branch);
      assert.equal((out.event as { reason: string }).reason, 'unsafe-branch');
      assert.equal(f.gitCalls.length, 0, 'nothing ran');
      assert.equal(f.prCalls.length, 0);
    }
  });

  it('skips with a reason when the branch is missing, there is no origin, or the push is refused', async () => {
    const missing = fakes({ git: (a) => (a[0] === 'rev-parse' ? { ok: false, message: '' } : { ok: true, stdout: '' }) });
    assert.equal(((await deliverBranch(base, missing.deps)).event as { reason: string }).reason, 'no-branch');
    assert.equal(missing.gitCalls.some((a) => a[0] === 'push'), false);

    const noRemote = fakes({ git: (a) => (a[0] === 'remote' ? { ok: false, message: 'No such remote' } : { ok: true, stdout: '' }) });
    assert.equal(((await deliverBranch(base, noRemote.deps)).event as { reason: string }).reason, 'no-remote');

    const refused = fakes({ git: (a) => (a[0] === 'push' ? { ok: false, message: '! [rejected] (non-fast-forward)\nhint: tip is behind' } : { ok: true, stdout: '' }) });
    const out = await deliverBranch(base, refused.deps);
    assert.equal((out.event as { reason: string }).reason, 'push-failed');
    assert.match((out.event as { message: string }).message, /non-fast-forward/);
    assert.match((out.event as { message: string }).message, /GitHub login/);
    assert.equal(refused.prCalls.length, 0, 'no PR for a branch that was not pushed');
  });

  it('a failed PR keeps the pushed branch and says so', async () => {
    const gh = fakes({ pr: { ok: false, reason: 'gh-missing', message: 'install gh' } });
    const out = await deliverBranch(base, gh.deps);
    assert.equal((out.event as { reason: string }).reason, 'gh-missing');
    assert.match((out.event as { message: string }).message, /The branch was pushed/);
    const none = fakes({ pr: { ok: false, reason: 'no-commits', message: 'no commits between dev and moag/x' } });
    assert.equal(((await deliverBranch(base, none.deps)).event as { reason: string }).reason, 'no-commits');
  });
});

// ─── real git ───

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

describe('deliverBranch against real git', function () {
  this.timeout(60_000);
  let root: string;
  let remote: string;
  let project: string;
  const noPr = { git: realDeliveryDeps.git, openPr: (): PrOutcome => ({ ok: true, url: 'https://github.com/o/r/pull/1' }) } as DeliveryDeps;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-delivery-'));
    remote = path.join(root, 'remote.git');
    project = path.join(root, 'project');
    git(root, 'init', '--bare', '-q', '--initial-branch=dev', remote);
    git(root, 'init', '-q', '--initial-branch=dev', project);
    git(project, 'config', 'user.email', 'm@example.test');
    git(project, 'config', 'user.name', 'MOAG test');
    git(project, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'base');
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'push', '-q', 'origin', 'dev');
    // the run's branch, as the import leaves it: a ref in the project with one extra commit
    git(project, 'branch', 'moag/run-1');
    git(project, 'switch', '-q', 'moag/run-1');
    fs.writeFileSync(path.join(project, 'b.txt'), 'b\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'run work');
    git(project, 'switch', '-q', 'dev');
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  const req = (over: Partial<DeliveryRequest> = {}): DeliveryRequest => ({ ...base, projectPath: project, branch: 'moag/run-1', mode: 'branch', ...over });
  const remoteBranches = (): string[] => git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

  it('pushes the run branch and nothing else', async () => {
    git(project, 'branch', 'private-experiment');
    const out = await deliverBranch(req(), noPr);
    assert.equal(out.event, null, out.note);
    assert.deepEqual(remoteBranches(), ['dev', 'moag/run-1']);
    assert.equal(git(remote, 'rev-parse', 'moag/run-1'), git(project, 'rev-parse', 'moag/run-1'));
  });

  it('does not overwrite a branch someone moved on the remote: the push is refused, never forced', async () => {
    await deliverBranch(req(), noPr);
    const theirs = git(remote, 'rev-parse', 'moag/run-1');
    // the project's branch is rewritten (history diverges), then delivered again
    git(project, 'switch', '-q', 'moag/run-1');
    git(project, 'reset', '-q', '--hard', 'dev');
    fs.writeFileSync(path.join(project, 'c.txt'), 'c\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'different history');
    git(project, 'switch', '-q', 'dev');
    const out = await deliverBranch(req(), noPr);
    assert.equal((out.event as { reason: string }).reason, 'push-failed');
    assert.equal(git(remote, 'rev-parse', 'moag/run-1'), theirs, 'the remote branch is untouched');
  });

  it('a pre-push hook in the project does not run', async () => {
    const marker = path.join(root, 'hook-ran');
    const hook = path.join(project, '.git', 'hooks', 'pre-push');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 });
    const out = await deliverBranch(req(), noPr);
    assert.equal(out.event, null, out.note);
    assert.equal(fs.existsSync(marker), false, 'hooks are off');
    assert.ok(remoteBranches().includes('moag/run-1'));
  });

  it('a missing branch and a missing origin are skipped with a reason, not an exception', async () => {
    assert.equal(((await deliverBranch(req({ branch: 'moag/nope' }), noPr)).event as { reason: string }).reason, 'no-branch');
    git(project, 'remote', 'remove', 'origin');
    assert.equal(((await deliverBranch(req(), noPr)).event as { reason: string }).reason, 'no-remote');
  });

  it('a branch outside the prefix is refused even though it exists', async () => {
    const out = await deliverBranch(req({ branch: 'dev' }), noPr);
    assert.equal((out.event as { reason: string }).reason, 'unsafe-branch');
    assert.deepEqual(remoteBranches(), ['dev']);
  });
});
