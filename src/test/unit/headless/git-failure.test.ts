// ─── classifyGitFailure: git's own words turned into the real reason and what to do about it ───

import { strict as assert } from 'assert';
import { DeliveryDeps, DeliveryRequest, classifyGitFailure, deliverBranch } from '../../../headless/remote-delivery';

const kind = (m: string): string => classifyGitFailure(m).kind;

describe('classifyGitFailure', () => {
  it('names a blocked port or unreachable network, and the port 443 way round it', () => {
    for (const m of [
      'ssh: connect to host github.com port 22: Connection timed out',
      'ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Could not read from remote repository.',
      'ssh: connect to host github.com port 22: Network is unreachable',
      'fatal: unable to access: Could not resolve host: github.com',
    ]) {
      assert.equal(kind(m), 'network-blocked', m);
    }
    assert.match(classifyGitFailure('connect to host github.com port 22: Connection timed out').text, /ssh\.github\.com on port 443/);
    assert.equal(kind('git did not finish in time.'), 'timeout');
  });

  it('tells a missing SSH key from a missing https login from an untrusted host', () => {
    assert.equal(kind('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'ssh-key');
    assert.equal(kind('fatal: could not read Username for https://github.com: terminal prompts disabled'), 'https-login');
    assert.equal(kind('remote: Invalid username or password.\nfatal: Authentication failed for https://github.com/o/r'), 'https-login');
    assert.equal(kind('Host key verification failed.\nfatal: Could not read from remote repository.'), 'host-key');
    assert.match(classifyGitFailure('fatal: could not read Username for x: terminal prompts disabled').text, /gh auth login/);
  });

  it('tells a missing repository, a branch rule and a moved branch apart', () => {
    assert.equal(kind('remote: Repository not found.\nfatal: repository https://github.com/o/r/ not found'), 'repo-not-found');
    assert.equal(kind('remote: error: GH006: Protected branch update failed for refs/heads/moag/x.'), 'protected-branch');
    assert.equal(kind('! [rejected] moag/x -> moag/x (non-fast-forward)'), 'moved-branch');
    assert.equal(kind('! [rejected] moag/x (fetch first)'), 'moved-branch');
  });

  it("keeps git's own words after the plain reason, shortened, and falls back to them when nothing matches", () => {
    const long = `ssh: connect to host github.com port 22: Connection timed out ${'x'.repeat(500)}`;
    const p = classifyGitFailure(long);
    assert.ok(p.text.includes('git said: ssh: connect to host'));
    assert.ok(p.text.length < 700, 'the raw message is cut');
    assert.deepEqual(classifyGitFailure('something odd'), { kind: 'other', text: 'git said: something odd' });
    assert.equal(classifyGitFailure('').kind, 'other');
  });

  it('puts the reason in the pr-skipped message a person reads in ONOSOO', async () => {
    const req: DeliveryRequest = {
      mode: 'draft-pr', projectPath: '/p', branch: 'moag/x', branchPrefix: 'moag/', base: 'dev',
      projectName: 'P', planName: 'plan', taskNames: [], exitCode: 0, runId: '11111111-2222-3333-4444-555555555555',
    };
    const deps: DeliveryDeps = {
      git: async (args) => (args[0] === 'push'
        ? { ok: false, message: 'ssh: connect to host github.com port 22: Connection timed out' }
        : { ok: true, stdout: '' }),
      openPr: () => { throw new Error('no PR for a branch that was not pushed'); },
    };
    const out = await deliverBranch(req, deps);
    assert.equal((out.event as { reason: string }).reason, 'push-failed');
    assert.match((out.event as { message: string }).message, /Many networks block port 22/);
  });
});
