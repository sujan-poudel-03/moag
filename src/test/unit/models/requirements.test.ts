import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseRequirements, assignRequirementIds, resolveRequirements, collectReservedRequirementIds,
  diffRequirements, stripRequirementTags, recommendBump, parseVersionLabel, nextVersionLabel,
  formatVersionLabel, preparePrdVersion, relabelLastPrdVersion, computeLatestDiff, RequirementDiff,
} from '../../../models/requirements';
import { PrdVersion } from '../../../models/types';
import { MAX_PRD_VERSIONS } from '../../../models/plan';
import { createEmptyPlan, createTask } from '../../../models/plan';

/** Join lines with LF — keeps fixtures readable. */
const md = (...lines: string[]) => lines.join('\n');

const ids = (markdown: string) => parseRequirements(markdown).items.map(i => i.text);

// ─── Heading rule (pinned — changing it re-identifies requirements in users' PRDs) ───

describe('parseRequirements — heading rule', () => {
  for (const heading of [
    '## Requirements',
    '### Functional requirements',
    '## Acceptance Criteria',
    '#### acceptance criteria',
    '# Requirement',
  ]) {
    it(`treats "${heading}" as a requirements heading`, () => {
      assert.deepEqual(ids(md(heading, '- one', '- two')), ['one', 'two']);
    });
  }

  for (const heading of ['## Goals', '## Prerequisites', '## Overview', '## Requirementsish']) {
    it(`does not treat "${heading}" as a requirements heading`, () => {
      assert.deepEqual(ids(md(heading, '- one', '- two')), []);
    });
  }

  it('keeps a deeper non-matching heading inside the section', () => {
    const text = md('## Requirements', '- top', '### Login', '- sign in', '- sign out');
    assert.deepEqual(ids(text), ['top', 'sign in', 'sign out']);
  });

  it('closes the section at a sibling heading that does not match', () => {
    const text = md('## Requirements', '- in', '## Technical Notes', '- out');
    assert.deepEqual(ids(text), ['in']);
  });

  it('closes the section at a shallower heading', () => {
    const text = md('## Requirements', '- in', '# Appendix', '- out');
    assert.deepEqual(ids(text), ['in']);
  });

  it('ignores items inside a fenced code block', () => {
    const text = md('## Requirements', '- real', '```', '- fenced', '## Not a heading', '```', '- also real',
      '~~~', '- tilde fenced', '~~~');
    assert.deepEqual(ids(text), ['real', 'also real']);
  });

  it('ignores items outside any requirements section', () => {
    const text = md('## Goals', '- goal', '## Requirements', '- req', '## Goals again', '- goal 2');
    assert.deepEqual(ids(text), ['req']);
  });
});

// ─── Item markers, checkboxes, continuation ───

describe('parseRequirements — items', () => {
  it('accepts -, *, +, 1., 1) and AC1: markers', () => {
    const text = md('## Requirements', '- dash', '* star', '+ plus', '1. dot', '2) paren', 'AC1: ac colon',
      'ac2. ac dot');
    assert.deepEqual(ids(text), ['dash', 'star', 'plus', 'dot', 'paren', 'ac colon', 'ac dot']);
  });

  it('parses the repo PRD template "AC1:" and "- AC1:" forms', () => {
    const text = md('## Acceptance Criteria', 'AC1: Users can log in', 'AC2: Users can log out',
      '## Technical Notes', 'x');
    assert.deepEqual(ids(text), ['Users can log in', 'Users can log out']);
    const bulleted = md('## Acceptance Criteria', '- AC1: first', '- [ ] second');
    assert.deepEqual(ids(bulleted), ['AC1: first', 'second']);
  });

  it('strips the checkbox from text and normalized', () => {
    const { items } = parseRequirements(md('## Requirements', '- [ ] Open item', '- [x] Done Item'));
    assert.deepEqual(items.map(i => i.text), ['Open item', 'Done Item']);
    assert.deepEqual(items.map(i => i.normalized), ['open item', 'done item']);
  });

  it('folds an indented child line into its parent', () => {
    const { items } = parseRequirements(md('## Requirements', '- parent', '  - child detail', '', '  more', '- next'));
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'parent - child detail more');
    assert.equal(items[1].text, 'next');
  });

  it('ends an item at a non-indented non-item line', () => {
    const { items } = parseRequirements(md('## Requirements', '- one', 'Plain paragraph', '  indented orphan'));
    assert.deepEqual(items.map(i => i.text), ['one']);
  });

  it('does not treat an item indented by 2+ columns (or a tab) as a top-level requirement', () => {
    assert.deepEqual(ids(md('## Requirements', '  - two spaces', '\t- tab')), []);
    assert.deepEqual(ids(md('## Requirements', ' - one space')), ['one space']);
  });

  it('reports 1-based line numbers and reads inline IDs', () => {
    const { items } = parseRequirements(md('# PRD', '## Requirements', '- [R-12] tagged', '- untagged'));
    assert.deepEqual(items.map(i => [i.id, i.line]), [['R-12', 3], [null, 4]]);
  });
});

// ─── F1.5: duplicate and double tags ───

describe('parseRequirements — ID errors', () => {
  it('reports a duplicate [R-12] naming the ID and both lines, keeping both items', () => {
    const text = md('## Requirements', '- [R-12] first', '- [R-1] other', '- [R-12] second');
    const { items, errors } = parseRequirements(text);
    assert.equal(items.length, 3);
    assert.deepEqual(items.filter(i => i.id === 'R-12').map(i => i.text), ['first', 'second']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'R-12');
    assert.equal(errors[0].line, 4);
    assert.match(errors[0].message, /R-12/);
    assert.match(errors[0].message, /\b2\b/);
    assert.match(errors[0].message, /\b4\b/);
  });

  it('reports a line that carries two tags', () => {
    const { errors } = parseRequirements(md('## Requirements', '- [R-1] [R-2] greedy'));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].message, /R-1, R-2/);
  });
});

// ─── F1.3: ID assignment and write-back ───

describe('assignRequirementIds', () => {
  const v1 = md('## Requirements', '- [R-1] login', '- [R-2] logout', '- [R-3] reset password');

  it('keeps R-1..R-3 and gives an inserted line R-4, never renumbering', () => {
    const v2 = md('## Requirements', '- [R-1] login', '- sign up', '- [R-2] logout', '- [R-3] reset password');
    const result = assignRequirementIds(v2, { previous: resolveRequirements(v1) });
    assert.equal(result.text, md('## Requirements', '- [R-1] login', '- [R-4] sign up', '- [R-2] logout',
      '- [R-3] reset password'));
    assert.deepEqual(result.requirements.map(r => r.id), ['R-1', 'R-4', 'R-2', 'R-3']);
    assert.deepEqual(result.requirements.map(r => r.tagged), [true, false, true, true]);
    assert.deepEqual(result.errors, []);
  });

  it('keeps legacy untagged IDs stable by exact normalized match', () => {
    const legacyV1 = md('## Requirements', '- login', '- logout', '- reset password');
    const legacyV2 = md('## Requirements', '- Login', '- sign up', '- logout', '- reset   password');
    const result = assignRequirementIds(legacyV2, { previous: resolveRequirements(legacyV1) });
    assert.deepEqual(result.requirements.map(r => r.id), ['R-1', 'R-4', 'R-2', 'R-3']);
    assert.equal(result.text, md('## Requirements', '- [R-1] Login', '- [R-4] sign up', '- [R-2] logout',
      '- [R-3] reset   password'));
  });

  it('writes the tag after the checkbox, after a numbered marker and after AC<n>:', () => {
    const text = md('## Acceptance Criteria', '- [ ] box', '1. numbered', 'AC1: criterion');
    assert.equal(assignRequirementIds(text).text,
      md('## Acceptance Criteria', '- [ ] [R-1] box', '1. [R-2] numbered', 'AC1: [R-3] criterion'));
  });

  it('does not reuse a removed ID that is still reserved', () => {
    const v2 = md('## Requirements', '- [R-1] login', '- brand new');
    const result = assignRequirementIds(v2, { previous: resolveRequirements(v1), reservedIds: ['R-9'] });
    assert.deepEqual(result.requirements.map(r => r.id), ['R-1', 'R-10']);
  });

  it('numbers above previous IDs even when they were removed from the document', () => {
    const v2 = md('## Requirements', '- [R-1] login', '- brand new');
    const result = assignRequirementIds(v2, { previous: resolveRequirements(v1) });
    assert.deepEqual(result.requirements.map(r => r.id), ['R-1', 'R-4']);
  });

  it('does not hand a previous ID to an untagged line when that ID is already used inline', () => {
    const v2 = md('## Requirements', '- [R-1] something else', '- login');
    const result = assignRequirementIds(v2, { previous: resolveRequirements(v1) });
    assert.deepEqual(result.requirements.map(r => r.id), ['R-1', 'R-4']);
  });

  it('preserves CRLF line endings', () => {
    const crlf = ['## Requirements', '- one', '- two', ''].join('\r\n');
    const result = assignRequirementIds(crlf);
    assert.equal(result.text, ['## Requirements', '- [R-1] one', '- [R-2] two', ''].join('\r\n'));
    // and a second pass is a no-op
    assert.equal(assignRequirementIds(result.text).text, result.text);
  });

  it('returns already-tagged input byte-identical (idempotent)', () => {
    const mixed = '## Requirements\r\n- [R-1] one\n- [R-2] two\r\n';
    assert.equal(assignRequirementIds(mixed).text, mixed);
    const once = assignRequirementIds(md('## Requirements', '- a', '- b')).text;
    assert.equal(assignRequirementIds(once).text, once);
  });

  it('passes duplicate-ID errors through', () => {
    const result = assignRequirementIds(md('## Requirements', '- [R-2] a', '- [R-2] b', '- c'));
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.requirements.map(r => r.id), ['R-2', 'R-2', 'R-3']);
  });
});

describe('collectReservedRequirementIds', () => {
  it('unions inline tags in every version, trace IDs and task requirementIds', () => {
    const plan = createEmptyPlan('Reserved');
    plan.prdVersions = [
      { version: '1.0.0', text: '## Requirements\n- [R-1] a\n- [R-5] b', createdAt: 'x' },
      { version: '1.1.0', text: '## Requirements\n- [R-2] a', createdAt: 'y' },
    ];
    plan.requirementTrace = [{ id: 'R-8', taskIds: [], commits: [], gates: [], releases: [] }];
    const task = createTask('T', 'p');
    task.requirementIds = ['R-11'];
    plan.playlists[0].tasks.push(task);
    assert.deepEqual([...collectReservedRequirementIds(plan)].sort(), ['R-1', 'R-11', 'R-2', 'R-5', 'R-8']);
  });
});

// ─── F1.4: diff ───

describe('diffRequirements', () => {
  const older = resolveRequirements(md('## Requirements', '- [R-1] login', '- [R-2] logout', '- [R-3] reset',
    '- [ ] [R-5] Export CSV'));
  const newer = resolveRequirements(md('## Requirements', '- [R-1]   LOGIN  ', '- [R-2] logout everywhere',
    '- [R-4] sign up', '- [x] [R-5] export csv'));

  it('puts each requirement in exactly one of the four buckets', () => {
    const diff = diffRequirements(older, newer);
    assert.deepEqual(diff.added, [{ id: 'R-4', text: 'sign up' }]);
    assert.deepEqual(diff.changed, [{ id: 'R-2', before: 'logout', after: 'logout everywhere' }]);
    assert.deepEqual(diff.removed, [{ id: 'R-3', text: 'reset' }]);
    assert.deepEqual(diff.unchanged.map(u => u.id), ['R-1', 'R-5']);
  });

  it('treats whitespace-only, case-only and checkbox flips as unchanged', () => {
    const diff = diffRequirements(older, newer);
    assert.ok(diff.unchanged.some(u => u.id === 'R-1'), 'whitespace/case edit');
    assert.ok(diff.unchanged.some(u => u.id === 'R-5'), 'checkbox flip');
  });

  it('sorts every bucket by the numeric part of the ID', () => {
    const a = resolveRequirements(md('## Requirements', '- [R-10] x', '- [R-9] y', '- [R-2] z'));
    const diff = diffRequirements([], a);
    assert.deepEqual(diff.added.map(x => x.id), ['R-2', 'R-9', 'R-10']);
  });

  it('returns four empty arrays for two empty PRDs', () => {
    assert.deepEqual(diffRequirements(resolveRequirements(''), resolveRequirements('')),
      { added: [], changed: [], removed: [], unchanged: [] });
  });

  it('is pure: same input, deep-equal output, inputs untouched', () => {
    const olderCopy = structuredClone(older);
    const newerCopy = structuredClone(newer);
    const first = diffRequirements(older, newer);
    const second = diffRequirements(older, newer);
    assert.deepEqual(first, second);
    assert.notEqual(first.added, second.added, 'output arrays are fresh');
    assert.deepEqual(older, olderCopy);
    assert.deepEqual(newer, newerCopy);
  });
});

describe('stripRequirementTags', () => {
  it('removes tags and the space write-back added, then trims', () => {
    assert.equal(stripRequirementTags('- [ ] [R-4] foo\n- [R-12] bar  '), '- [ ] foo\n- bar');
    const original = md('## Requirements', '- a', '1. b');
    assert.equal(stripRequirementTags(assignRequirementIds(original).text), original);
  });
});

describe('requirements module boundary', () => {
  it('imports no vscode, fs or path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../models/requirements.ts'), 'utf-8');
    assert.ok(!/from 'vscode'/.test(source));
    assert.ok(!/require\('vscode'\)/.test(source));
    assert.ok(!/from '(fs|path)'/.test(source));
  });
});

// ─── F2-1: semver recommendation, labels, save preparation ───

const emptyDiff = (): RequirementDiff => ({ added: [], changed: [], removed: [], unchanged: [] });

describe('recommendBump', () => {
  it('any removed requirement → major, naming the removed IDs', () => {
    const diff = { ...emptyDiff(), removed: [{ id: 'R-3', text: 'a' }, { id: 'R-5', text: 'b' }], added: [{ id: 'R-9', text: 'c' }] };
    assert.deepEqual(recommendBump(diff, true), { bump: 'major', rationale: 'Major: removed R-3, R-5.' });
  });

  it('added or changed (nothing removed) → minor, naming both kinds', () => {
    const diff = { ...emptyDiff(), added: [{ id: 'R-4', text: 'a' }], changed: [{ id: 'R-2', before: 'x', after: 'y' }] };
    assert.deepEqual(recommendBump(diff, true), { bump: 'minor', rationale: 'Minor: added R-4; changed R-2.' });
    const onlyChanged = { ...emptyDiff(), changed: [{ id: 'R-7', before: 'x', after: 'y' }] };
    assert.equal(recommendBump(onlyChanged, true).rationale, 'Minor: changed R-7.');
  });

  it('text outside the requirement list → patch', () => {
    const rec = recommendBump({ ...emptyDiff(), unchanged: [{ id: 'R-1', text: 'a' }] }, true);
    assert.equal(rec.bump, 'patch');
    assert.match(rec.rationale, /^Patch: text outside the requirement list changed/);
  });

  it('identical text → no bump', () => {
    assert.equal(recommendBump(emptyDiff(), false).bump, null);
  });

  it('caps the ID list at 10 then summarises', () => {
    const removed = Array.from({ length: 13 }, (_, i) => ({ id: `R-${i + 1}`, text: 't' }));
    const rec = recommendBump({ ...emptyDiff(), removed }, true);
    assert.equal(rec.rationale, 'Major: removed R-1, R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10 …and 3 more.');
  });
});

describe('version labels', () => {
  const v = (...labels: string[]) => labels.map(version => ({ version }));

  it('parses legacy and semver labels; rejects non-versions', () => {
    assert.deepEqual(parseVersionLabel('v1.0'), { major: 1, minor: 0, patch: 0 });
    assert.deepEqual(parseVersionLabel('2.3.4'), { major: 2, minor: 3, patch: 4 });
    assert.deepEqual(parseVersionLabel('V7'), { major: 7, minor: 0, patch: 0 });
    assert.equal(parseVersionLabel('draft'), null);
    assert.equal(parseVersionLabel('1.2.3.4'), null);
  });

  it('first version is 1.0.0', () => {
    assert.equal(nextVersionLabel([], 'minor'), '1.0.0');
  });

  it(`F2.2: ${MAX_PRD_VERSIONS} retained entries ending in 2.3.0 → a major save is 3.0.0, never v21.0`, () => {
    const versions = Array.from({ length: MAX_PRD_VERSIONS }, (_, i) =>
      ({ version: i === MAX_PRD_VERSIONS - 1 ? '2.3.0' : `1.${i}.0` }));
    const next = nextVersionLabel(versions, 'major');
    assert.equal(next, '3.0.0');
    assert.notEqual(next, `v${versions.length + 1}.0`);
  });

  it('reads legacy v1.0 / v2.0 as 1.0.0 / 2.0.0', () => {
    assert.equal(nextVersionLabel(v('v1.0', 'v2.0'), 'minor'), '2.1.0');
    assert.equal(nextVersionLabel(v('v1.0', 'v2.0'), 'patch'), '2.0.1');
  });

  it('an unparsable last label falls back to the nearest parsable one, else 0.0.0', () => {
    assert.equal(nextVersionLabel(v('1.4.0', 'draft', 'final'), 'minor'), '1.5.0');
    assert.equal(nextVersionLabel(v('draft'), 'major'), '1.0.0');
  });

  it('never collides with an existing label', () => {
    // last is 1.0.0, but 1.1.0 and v1.1.1 already exist (e.g. hand-edited history)
    assert.equal(nextVersionLabel(v('1.1.0', 'v1.1.1', '1.0.0'), 'minor'), '1.1.2');
  });

  it('formats a display label with exactly one v', () => {
    assert.equal(formatVersionLabel('2.1.0'), 'v2.1.0');
    assert.equal(formatVersionLabel('v2.0'), 'v2.0');
    assert.equal(formatVersionLabel('V3'), 'V3');
  });
});

describe('preparePrdVersion', () => {
  const at = '2026-10-04T00:00:00.000Z';
  const v1Text = md('# Login', '## Requirements', '- [R-1] login', '- [R-2] logout', '- [R-3] reset');
  const v1: PrdVersion = { version: '1.0.0', text: v1Text, createdAt: at };

  it('first save → 1.0.0 with tags written and no bump fields', () => {
    const r = preparePrdVersion({ text: md('## Requirements', '- a', '- b'), versions: [], createdAt: at });
    assert.ok(r.ok);
    assert.equal(r.entry.version, '1.0.0');
    assert.equal(r.taggedText, md('## Requirements', '- [R-1] a', '- [R-2] b'));
    assert.equal(r.entry.text, r.taggedText);
    assert.equal(r.diff, null);
    assert.ok(!('recommendedBump' in r.entry) && !('chosenBump' in r.entry));
  });

  it('adding an untagged line → minor, the rationale names the new ID', () => {
    const r = preparePrdVersion({ text: md(v1Text, '- sign up'), versions: [v1], createdAt: at });
    assert.ok(r.ok);
    assert.deepEqual(r.diff?.added, [{ id: 'R-4', text: 'sign up' }]);
    assert.equal(r.recommendation.bump, 'minor');
    assert.match(r.recommendation.rationale, /R-4/);
    assert.equal(r.entry.version, '1.1.0');
    assert.equal(r.entry.recommendedBump, 'minor');
    assert.equal(r.entry.chosenBump, 'minor');
    assert.ok(r.taggedText.endsWith('- [R-4] sign up'));
  });

  it('removing a line → major naming the removed ID', () => {
    const r = preparePrdVersion({ text: md('# Login', '## Requirements', '- [R-1] login', '- [R-2] logout'), versions: [v1] });
    assert.ok(r.ok);
    assert.equal(r.recommendation.bump, 'major');
    assert.match(r.recommendation.rationale, /R-3/);
    assert.equal(r.entry.version, '2.0.0');
  });

  it('editing only prose → patch', () => {
    const r = preparePrdVersion({ text: v1Text.replace('# Login', '# Login and sessions'), versions: [v1] });
    assert.ok(r.ok);
    assert.equal(r.recommendation.bump, 'patch');
    assert.equal(r.entry.version, '1.0.1');
  });

  it('identical text (ignoring tags) → refused as no-change', () => {
    const untagged = md('# Login', '## Requirements', '- login', '- logout', '- reset');
    const r = preparePrdVersion({ text: untagged, versions: [v1] });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'no-change');
    assert.match(!r.ok ? r.message : '', /No changes since v1\.0\.0/);
  });

  it('a duplicate inline ID is refused with the ID and both lines', () => {
    const r = preparePrdVersion({ text: md('## Requirements', '- [R-1] a', '- [R-1] b'), versions: [v1] });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.reason === 'duplicate-ids');
    assert.match(!r.ok ? r.message : '', /R-1 appears on lines 2 and 3/);
  });

  it('a reserved (removed) ID is never reused for a new line', () => {
    const r = preparePrdVersion({ text: md(v1Text, '- new'), versions: [v1], reservedIds: ['R-8'] });
    assert.ok(r.ok);
    assert.deepEqual(r.diff?.added.map(a => a.id), ['R-9']);
  });

  it('F2.3: override major over a recommended minor records both and labels from major', () => {
    const r = preparePrdVersion({ text: md(v1Text, '- sign up'), versions: [v1], override: 'major' });
    assert.ok(r.ok);
    assert.equal(r.entry.recommendedBump, 'minor');
    assert.equal(r.entry.chosenBump, 'major');
    assert.equal(r.entry.version, '2.0.0');
  });

  it('a legacy untagged last version is matched by text (virtual IDs)', () => {
    const legacy: PrdVersion = { version: 'v2.0', text: md('## Requirements', '- login', '- logout'), createdAt: at };
    const r = preparePrdVersion({ text: md('## Requirements', '- login', '- logout', '- reset'), versions: [legacy] });
    assert.ok(r.ok);
    assert.deepEqual(r.diff?.added.map(a => a.id), ['R-3']);
    assert.deepEqual(r.diff?.unchanged.map(a => a.id), ['R-1', 'R-2']);
    assert.equal(r.entry.version, '2.1.0');
  });
});

describe('relabelLastPrdVersion / computeLatestDiff', () => {
  const at = '2026-10-04T00:00:00.000Z';
  const a: PrdVersion = { version: '1.0.0', text: md('## Requirements', '- [R-1] a'), createdAt: at };
  const b: PrdVersion = {
    version: '1.1.0', text: md('## Requirements', '- [R-1] a', '- [R-2] b'), createdAt: at,
    recommendedBump: 'minor', chosenBump: 'minor',
  };

  it('relabels the last entry from the one before it and records the chosen bump', () => {
    const input = [a, b];
    const out = relabelLastPrdVersion(input, 'major');
    assert.ok(out);
    assert.equal(out[1].version, '2.0.0');
    assert.equal(out[1].chosenBump, 'major');
    assert.equal(out[1].recommendedBump, 'minor');
    assert.equal(input[1].version, '1.1.0', 'input not mutated');
  });

  it('returns null for a single entry or an entry without a recommendation', () => {
    assert.equal(relabelLastPrdVersion([a], 'major'), null);
    assert.equal(relabelLastPrdVersion([a, { ...b, recommendedBump: undefined }], 'major'), null);
  });

  it('diffs the last two versions, or returns null with fewer than two', () => {
    assert.equal(computeLatestDiff([a]), null);
    assert.deepEqual(computeLatestDiff([a, b])?.added, [{ id: 'R-2', text: 'b' }]);
  });

  it('a save from a legacy untagged version and the later diff of the same pair agree on IDs', () => {
    const legacy: PrdVersion = { version: 'v1.0', text: md('## Requirements', '- login', '- logout'), createdAt: at };
    // R-1 is already reserved (e.g. a task tag), so virtual IDs cannot simply start at R-1.
    const reservedAtSave = ['R-1'];
    const prep = preparePrdVersion({
      text: md('## Requirements', '- login', '- reset'), versions: [legacy], reservedIds: reservedAtSave, createdAt: at,
    });
    assert.ok(prep.ok);
    // After the save the newer version's inline tags are reserved too, as collectReservedRequirementIds reports.
    const reservedAfter = [...reservedAtSave, ...(prep.entry.text.match(/R-\d+/g) ?? [])];
    const later = computeLatestDiff([legacy, prep.entry], reservedAfter);
    assert.deepEqual(later, prep.diff);
    assert.equal(prep.diff?.removed.length, 1);
    assert.equal(prep.diff?.removed[0].text, 'logout');
  });

  it('matches an untagged legacy older version to the newer tags by text', () => {
    const legacy: PrdVersion = { version: 'v1.0', text: md('## Requirements', '- a', '- gone'), createdAt: at };
    const diff = computeLatestDiff([legacy, b], ['R-1', 'R-2']);
    assert.ok(diff);
    assert.deepEqual(diff.unchanged.map(u => u.id), ['R-1']);
    assert.deepEqual(diff.added.map(u => u.id), ['R-2']);
    assert.deepEqual(diff.removed.map(u => u.text), ['gone']);
  });
});
