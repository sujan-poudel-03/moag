#!/usr/bin/env node
// Dry-run stand-in for the greenfield todo CLI (PRD v2: list in ascending id
// order; an unknown id on `complete` is an error). Plain JavaScript on
// purpose: the benchmark dry-run only proves the harness, offline, at zero cost.
'use strict';
const fs = require('fs');
const path = require('path');

function storePath() {
  return process.env.TODO_FILE || path.join(process.cwd(), 'todos.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') { return []; }
    throw err;
  }
}

function save(todos) {
  fs.writeFileSync(storePath(), JSON.stringify(todos, null, 2) + '\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const todos = load();
  if (cmd === 'add') {
    const text = rest.join(' ').trim();
    if (!text) { process.stderr.write('Usage: todo add "<text>"\n'); return 1; }
    const id = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    todos.push({ id, text, done: false });
    save(todos);
    process.stdout.write(`Added ${id}: ${text}\n`);
    return 0;
  }
  if (cmd === 'list') {
    if (todos.length === 0) { process.stdout.write('No todos.\n'); return 0; }
    for (const t of [...todos].sort((a, b) => a.id - b.id)) { process.stdout.write(`${t.id} [${t.done ? 'x' : ' '}] ${t.text}\n`); }
    return 0;
  }
  if (cmd === 'complete') {
    const id = Number(rest[0]);
    const t = todos.find((x) => x.id === id);
    if (!t) { process.stderr.write(`No todo with id ${rest[0]}\n`); return 1; }
    t.done = true;
    save(todos);
    process.stdout.write(`Completed ${id}\n`);
    return 0;
  }
  process.stderr.write('Usage: todo <add|list|complete> ...\n');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
