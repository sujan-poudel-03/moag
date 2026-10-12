'use strict';
// Dry-run stand-in tests for PRD v3 (R-6 to R-8). node:test, no dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'todo.js');

function store() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');
}

function todo(file, extraEnv, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, TODO_FILE: file, ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('R-6: add --due stores a due date; an invalid date adds nothing and exits 1', () => {
  const f = store();
  assert.equal(todo(f, {}, 'add', 'pay rent', '--due', '2026-11-01').out, 'Added 1: pay rent\n');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))[0].due, '2026-11-01');
  for (const bad of ['2026-02-30', '11/01/2026', 'tomorrow']) {
    const r = todo(f, {}, 'add', 'x', '--due', bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /due date/i);
  }
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, 1, 'nothing was added');
});

test('R-7: list appends the due date', () => {
  const f = store();
  todo(f, {}, 'add', 'a');
  todo(f, {}, 'add', 'b', '--due', '2026-01-02');
  assert.equal(todo(f, {}, 'list').out, '1 [ ] a\n2 [ ] b (due 2026-01-02)\n');
});

test('R-8: list --overdue shows only open todos due before today (TODO_TODAY overrides today)', () => {
  const f = store();
  todo(f, {}, 'add', 'past', '--due', '2026-01-01');
  todo(f, {}, 'add', 'today', '--due', '2026-03-01');
  todo(f, {}, 'add', 'future', '--due', '2026-12-31');
  todo(f, {}, 'add', 'done past', '--due', '2025-12-01');
  todo(f, {}, 'add', 'no date');
  todo(f, {}, 'complete', '4');
  assert.equal(todo(f, { TODO_TODAY: '2026-03-01' }, 'list', '--overdue').out, '1 [ ] past (due 2026-01-01)\n');
  assert.equal(todo(f, { TODO_TODAY: '2027-01-01' }, 'list', '--overdue').out,
    '1 [ ] past (due 2026-01-01)\n2 [ ] today (due 2026-03-01)\n3 [ ] future (due 2026-12-31)\n');
});
