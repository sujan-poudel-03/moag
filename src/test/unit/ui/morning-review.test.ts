import * as assert from 'assert';
// morning-review imports vscode, so load it through the shared mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');
const { renderReviewMarkdown } = proxyquire('../../../ui/morning-review', { vscode: vscodeMock }) as
  typeof import('../../../ui/morning-review');
import { Digest, DigestCommit } from '../../../runner/digest';
import { ParkedItem, ParkReason } from '../../../runner/park-queue';

const NOW = '2026-08-25T09:00:00.000Z';

const parked = (reason: ParkReason, over: Partial<ParkedItem> = {}): ParkedItem => ({
  id: 'id-' + reason,
  parkedAt: '2026-08-25T03:00:00.000Z',
  reason,
  planName: 'Nightly',
  playlistName: 'Backend',
  taskId: 't1',
  taskName: 'Ship the API',
  decision: 'Review the change and approve it.',
  ...over,
});

const commit = (over: Partial<DigestCommit> = {}): DigestCommit => ({
  sha: 'abc12345',
  subject: 'Add login route',
  at: '2026-08-25T02:00:00.000Z',
  branch: 'moag/nightly-run1',
  costUsd: 0.5,
  ...over,
});

const digest = (over: Partial<Digest> = {}): Digest => ({
  needsDecision: [],
  shipped: [],
  branches: [],
  totalCostUsd: 0,
  ...over,
});

describe('morning-review — decisions come first', () => {
  it('puts what needs a decision above the commit log', () => {
    const md = renderReviewMarkdown(
      digest({ needsDecision: [parked('manual-gate')], shipped: [commit()], branches: ['moag/x'], totalCostUsd: 0.5 }),
      NOW,
    );
    assert.ok(md.indexOf('need a decision') < md.indexOf('## Shipped'),
      'a blocked decision is why the operator opened this');
  });

  it('says so plainly when nothing is waiting', () => {
    assert.ok(renderReviewMarkdown(digest(), NOW).includes('Nothing is waiting on you'));
  });

  it('shows the id and how to clear it', () => {
    const md = renderReviewMarkdown(digest({ needsDecision: [parked('manual-gate', { id: 'xyz' })] }), NOW);
    assert.ok(md.includes('`xyz`'));
    assert.ok(md.includes('Resolve Parked Item'), 'the reader must know how to act on it');
  });

  it('states the decision, not just the reason', () => {
    const md = renderReviewMarkdown(digest({ needsDecision: [parked('budget-exceeded', {
      decision: 'Raise the ceiling, reduce scope, or stop here.',
    })] }), NOW);
    assert.ok(md.includes('Your call:'));
    assert.ok(md.includes('Raise the ceiling'));
  });

  it('includes gate evidence when there is any', () => {
    const md = renderReviewMarkdown(digest({ needsDecision: [parked('gate-failure', {
      evidence: { gate: 'npm test', lastError: 'AssertionError: expected 1 to equal 2' },
    })] }), NOW);
    assert.ok(md.includes('`npm test`'));
    assert.ok(md.includes('AssertionError'));
  });

  it('caps a huge error so one failure cannot swamp the page', () => {
    const md = renderReviewMarkdown(digest({ needsDecision: [parked('repeated-failure', {
      evidence: { lastError: 'x'.repeat(5000) },
    })] }), NOW);
    assert.ok(md.length < 3000, `review ballooned to ${md.length} chars`);
  });
});

describe('morning-review — shipped work', () => {
  it('renders commits as a table with cost', () => {
    const md = renderReviewMarkdown(
      digest({ shipped: [commit({ costUsd: 0.25 })], branches: ['moag/x'], totalCostUsd: 0.25 }),
      NOW,
    );
    assert.ok(md.includes('| `abc12345` |'));
    assert.ok(md.includes('$0.2500'));
    assert.ok(md.includes('`moag/x`'));
  });

  it('escapes a pipe in a subject so the table cannot break', () => {
    const md = renderReviewMarkdown(digest({ shipped: [commit({ subject: 'fix a | b' })] }), NOW);
    const row = md.split('\n').find((l) => l.includes('abc12345'))!;
    assert.ok(row.includes('a \\| b'), `unescaped pipe would split the row: ${row}`);
  });

  it('shows an em dash for unknown cost rather than $0', () => {
    const md = renderReviewMarkdown(digest({ shipped: [commit({ costUsd: undefined })] }), NOW);
    const row = md.split('\n').find((l) => l.includes('abc12345'))!;
    assert.ok(row.includes('—'), 'unknown cost must not render as a number');
  });

  it('flags that a night with commits but no recorded cost was not free', () => {
    const md = renderReviewMarkdown(digest({ shipped: [commit({ costUsd: undefined })] }), NOW);
    assert.ok(md.includes('No cost was recorded'));
  });

  it('makes no such claim when nothing shipped', () => {
    assert.ok(!renderReviewMarkdown(digest(), NOW).includes('No cost was recorded'));
  });
});
