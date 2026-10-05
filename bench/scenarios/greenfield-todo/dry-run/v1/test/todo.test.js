'use strict';
// Dry-run stand-in tests for PRD v1 (R-1 to R-4). node:test, no dependencies.
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

function todo(file, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, TODO_FILE: file }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('R-1: add assigns integer ids from 1 and echoes the todo', () => {
  const f = store();
  assert.equal(todo(f, 'add', 'buy milk').out, 'Added 1: buy milk\n');
  assert.equal(todo(f, 'add', 'walk dog').out, 'Added 2: walk dog\n');
});

test('R-2: list shows open and done todos, or "No todos."', () => {
  const f = store();
  assert.equal(todo(f, 'list').out, 'No todos.\n');
  todo(f, 'add', 'a');
  todo(f, 'add', 'b');
  todo(f, 'complete', '2');
  assert.equal(todo(f, 'list').out, '1 [ ] a\n2 [x] b\n');
});

test('R-3: complete marks the todo done', () => {
  const f = store();
  todo(f, 'add', 'a');
  const r = todo(f, 'complete', '1');
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Completed 1\n');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))[0].done, true);
});

test('R-4: todos persist in TODO_FILE; a missing file is an empty list', () => {
  const f = store();
  assert.equal(fs.existsSync(f), false);
  assert.equal(todo(f, 'list').out, 'No todos.\n');
  todo(f, 'add', 'kept');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, 1);
  assert.equal(todo(f, 'list').out, '1 [ ] kept\n');
});
