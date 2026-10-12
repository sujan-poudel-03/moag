#!/usr/bin/env node
// Dry-run stand-in for the greenfield todo CLI (PRD v3: due dates and an
// overdue filter). Plain JavaScript on purpose: the benchmark dry-run only
// proves the harness, offline, at zero cost.
'use strict';
const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/** True for a real calendar date written as YYYY-MM-DD. */
function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) { return false; }
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function today() {
  const t = process.env.TODO_TODAY;
  return isDate(t) ? t : new Date().toISOString().slice(0, 10);
}

function line(t) {
  return `${t.id} [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ` (due ${t.due})` : ''}\n`;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const todos = load();
  if (cmd === 'add') {
    const words = [];
    let due = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--due') {
        due = rest[++i];
        if (!isDate(due)) { process.stderr.write(`Invalid due date: ${due ?? '(missing)'} (expected YYYY-MM-DD)\n`); return 1; }
      } else {
        words.push(rest[i]);
      }
    }
    const text = words.join(' ').trim();
    if (!text) { process.stderr.write('Usage: todo add "<text>" [--due YYYY-MM-DD]\n'); return 1; }
    const id = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    todos.push({ id, text, done: false, ...(due ? { due } : {}) });
    save(todos);
    process.stdout.write(`Added ${id}: ${text}\n`);
    return 0;
  }
  if (cmd === 'list') {
    const overdue = rest.includes('--overdue');
    const now = today();
    const shown = [...todos].sort((a, b) => a.id - b.id).filter((t) => !overdue || (!t.done && t.due && t.due < now));
    if (shown.length === 0) { process.stdout.write('No todos.\n'); return 0; }
    for (const t of shown) { process.stdout.write(line(t)); }
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
