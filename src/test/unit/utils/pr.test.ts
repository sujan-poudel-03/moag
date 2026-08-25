import * as assert from 'assert';
import {
  buildPrBody,
  createPullRequest,
  describeFailure,
  isGhAvailable,
  GhRunner,
  PrOutcome,
} from '../../../utils/pr';

/** A gh stub: records the args it was called with, and replays scripted results. */
function stubGh(handler: (args: string[]) => string): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    return handler(args);
  };
  return { gh, calls };
}

const okGh = (out = 'https://github.com/o/r/pull/7') =>
  stubGh((args) => (args[0] === '--version' ? 'gh version 2.0.0' : out));

describe('utils/pr — buildPrBody', () => {
  it('renders a checklist with pass and fail marks', () => {
    const body = buildPrBody({
      planName: 'Auth rewrite',
      tasks: [
        { name: 'Add login route', completed: true },
        { name: 'Add refresh token', completed: false },
      ],
      changedFiles: ['src/auth.ts'],
    });
    assert.ok(body.includes('- ✅ Add login route'));
    assert.ok(body.includes('- ❌ Add refresh token'));
    assert.ok(body.includes('- `src/auth.ts`'));
    assert.ok(body.includes('Auth rewrite'));
  });

  it('states plainly when nothing changed rather than rendering an empty section', () => {
    const body = buildPrBody({ planName: 'p', tasks: [], changedFiles: [] });
    assert.ok(body.includes('No file changes detected.'));
    assert.ok(body.includes('No tasks recorded for this run.'));
  });

  it('falls back to "untitled" for a blank plan name', () => {
    const body = buildPrBody({ planName: '   ', tasks: [], changedFiles: [] });
    assert.ok(body.includes('"untitled"'));
  });
});

describe('utils/pr — createPullRequest', () => {
  const req = { cwd: '/repo', title: 'T', planName: 'P', tasks: [], changedFiles: [] };

  it('returns the PR url from the last line of gh output', () => {
    const { gh } = okGh('Creating pull request...\nhttps://github.com/o/r/pull/7\n');
    const out = createPullRequest(req, gh);
    assert.strictEqual(out.ok, true);
    assert.strictEqual((out as Extract<PrOutcome, { ok: true }>).url, 'https://github.com/o/r/pull/7');
  });

  it('passes every value as a discrete arg so a title can never reach a shell', () => {
    const { gh, calls } = okGh();
    createPullRequest({ ...req, title: 'fix; rm -rf /' }, gh);
    const create = calls.find((c) => c[0] === 'pr')!;
    assert.strictEqual(create[create.indexOf('--title') + 1], 'fix; rm -rf /');
  });

  it('forwards --base only when one is given', () => {
    const { gh, calls } = okGh();
    createPullRequest({ ...req, base: 'develop' }, gh);
    assert.ok(calls.find((c) => c[0] === 'pr')!.includes('develop'));

    const second = okGh();
    createPullRequest(req, second.gh);
    assert.ok(!second.calls.find((c) => c[0] === 'pr')!.includes('--base'));
  });

  it('reports gh-missing without attempting to create anything', () => {
    const { gh, calls } = stubGh(() => { throw new Error('ENOENT'); });
    const out = createPullRequest(req, gh);
    assert.strictEqual(out.ok, false);
    assert.strictEqual((out as Extract<PrOutcome, { ok: false }>).reason, 'gh-missing');
    assert.ok(!calls.some((c) => c[0] === 'pr'), 'must not call pr create when gh is absent');
  });

  it('distinguishes an empty branch from a generic failure', () => {
    const empty = stubGh((a) => {
      if (a[0] === '--version') { return 'ok'; }
      throw new Error('pull request create failed: no commits between main and topic');
    });
    assert.strictEqual((createPullRequest(req, empty.gh) as never as { reason: string }).reason, 'no-commits');

    const other = stubGh((a) => {
      if (a[0] === '--version') { return 'ok'; }
      throw new Error('HTTP 403: Resource not accessible');
    });
    assert.strictEqual((createPullRequest(req, other.gh) as never as { reason: string }).reason, 'failed');
  });
});

describe('utils/pr — reporting', () => {
  it('gives every failure reason its own actionable line', () => {
    const seen = new Set<string>();
    for (const reason of ['gh-missing', 'no-commits', 'failed'] as const) {
      const text = describeFailure({ ok: false, reason, message: 'boom' });
      assert.ok(text.length > 0, `${reason} must have a message`);
      assert.ok(!seen.has(text), `${reason} must not reuse another reason's message`);
      seen.add(text);
    }
  });

  it('isGhAvailable is false when gh cannot run', () => {
    assert.strictEqual(isGhAvailable('/repo', () => { throw new Error('ENOENT'); }), false);
    assert.strictEqual(isGhAvailable('/repo', () => 'gh version 2.0.0'), true);
  });
});
