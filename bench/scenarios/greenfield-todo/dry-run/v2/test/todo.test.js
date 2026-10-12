'use strict';
// Dry-run stand-in tests for PRD v2 (R-1 to R-4). node:test, plus the local todo-format
// devDependency, which exists only once MOAG has installed it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatTodo } = require('todo-format');

const BIN = path.join(__dirname, '..', 'bin', 'todo.js');

function store() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');
}

function todo(file, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, TODO_FILE: file }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('R-1: add assigns integer ids from 1 and echoes the todo', () => {
  const f = store();
  assert.equal(todo(f, 'add', 'buy milk').out, 'Added 1: buy milk\n');
  assert.equal(todo(f, 'add', 'walk dog').out, 'Added 2: walk dog\n');
});

test('R-2: list shows todos in ascending id order, or "No todos."', () => {
  const f = store();
  assert.equal(todo(f, 'list').out, 'No todos.\n');
  fs.writeFileSync(f, JSON.stringify([{ id: 2, text: 'b', done: true }, { id: 1, text: 'a', done: false }]));
  assert.equal(todo(f, 'list').out, '1 [ ] a\n2 [x] b\n');
});

test('R-3: complete marks the todo done; an unknown id is an error', () => {
  const f = store();
  todo(f, 'add', 'a');
  const ok = todo(f, 'complete', '1');
  assert.equal(ok.code, 0);
  assert.equal(ok.out, 'Completed 1\n');
  const bad = todo(f, 'complete', '9');
  assert.equal(bad.code, 1);
  assert.equal(bad.out, '');
  assert.equal(bad.err, 'No todo with id 9\n');
});

test('R-4: todos persist in TODO_FILE; a missing file is an empty list', () => {
  const f = store();
  assert.equal(todo(f, 'list').out, 'No todos.\n');
  todo(f, 'add', 'kept');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, 1);
});

test('the installed devDependency formats a todo the way list prints it', () => {
  assert.equal(formatTodo({ id: 2, done: true, text: 'b' }), '2 [x] b');
});
