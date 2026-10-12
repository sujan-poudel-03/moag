// ─── Task changes collector — real temp repositories ───

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectTaskChanges,
  fitEventSize,
  parseNameStatusZ,
  parseNumstatZ,
  TASK_CHANGES_LIMITS,
  TaskChangesPayload,
  TaskSettledInfo,
  truncateUtf8,
} from '../../../runner/task-changes';
import { EMPTY_TREE_REF } from '../../../runner/evidence';
import { TaskStatus } from '../../../models/types';
import { createRedactor, Redactor } from '../../../utils/redact';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

function tmp(prefix = 'moag-tc-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function newRepo(): string {
  const dir = tmp();
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

function write(dir: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

const signal = (): AbortSignal => new AbortController().signal;
const noRedact = createRedactor([]);

function info(cwd: string, over: Partial<TaskSettledInfo> = {}): TaskSettledInfo {
  return {
    taskId: 't1',
    status: TaskStatus.Completed,
    cwd,
    snapshotRef: null,
    headRef: null,
    untrackedAtStart: null,
    commit: null,
    ...over,
  };
}

describe('task-changes — collector over real git', function () {
  this.timeout(60_000);

  before(function () {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      if (isSpawnEperm(err)) { this.skip(); }
      throw err;
    }
  });

  it('worktree: modified, untracked-new, rename, binary; excludes start-untracked and .moag', async () => {
    const dir = newRepo();
    write(dir, 'a.txt', 'one\ntwo\n');
    write(dir, 'b.txt', 'rename me\nline 2\nline 3\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    write(dir, 'old.txt', 'was already here\n');
    const headRef = git(dir, 'rev-parse', 'HEAD');
    const snapshot = git(dir, 'stash', 'create') || null;

    write(dir, 'a.txt', 'one\nTWO\nthree\n');
    git(dir, 'mv', 'b.txt', 'c.txt');
    write(dir, 'new.txt', 'x\ny\nz\n');
    write(dir, 'img.bin', Buffer.from([1, 0, 2, 3]));
    write(dir, '.moag/x.json', '{}');

    const out = await collectTaskChanges(info(dir, { snapshotRef: snapshot, headRef, untrackedAtStart: ['old.txt'] }), noRedact, signal());
    assert.ok(out);
    assert.equal(out.source, 'worktree');
    assert.equal(out.base_sha, headRef);
    assert.equal(out.commit_sha, null);
    assert.equal(typeof out.branch, 'string');
    const byPath = new Map(out.files.map((f) => [f.path, f]));
    assert.deepEqual([...byPath.keys()], ['a.txt', 'c.txt', 'img.bin', 'new.txt']);
    assert.deepEqual(byPath.get('a.txt'), { path: 'a.txt', status: 'modified', binary: false, added: 2, removed: 1 });
    assert.deepEqual(byPath.get('c.txt'), { path: 'c.txt', status: 'renamed', old_path: 'b.txt', binary: false, added: 0, removed: 0 });
    assert.deepEqual(byPath.get('new.txt'), { path: 'new.txt', status: 'added', binary: false, added: 3, removed: 0 });
    assert.deepEqual(byPath.get('img.bin'), { path: 'img.bin', status: 'added', binary: true, added: null, removed: null });
    assert.ok(out.diff);
    assert.ok(out.diff.text.includes('+++ b/new.txt'));
    assert.ok(out.diff.text.includes('Binary files /dev/null and b/img.bin differ'));
    assert.ok(!out.diff.text.includes('.moag'));
    assert.equal(out.diff.truncated, false);
    assert.ok(!('truncated' in out));
  });

  it('worktree: a tracked binary change has null counts', async () => {
    const dir = newRepo();
    write(dir, 'b.bin', Buffer.from([0, 1, 2]));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const headRef = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'b.bin', Buffer.from([0, 9, 9, 9]));
    const out = await collectTaskChanges(info(dir, { headRef, untrackedAtStart: [] }), noRedact, signal());
    assert.deepEqual(out?.files, [{ path: 'b.bin', status: 'modified', binary: true, added: null, removed: null }]);
  });

  it('commit: full sha, base..commit files and the delivery branch', async () => {
    const dir = newRepo();
    write(dir, 'a.txt', 'one\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const headRef = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'a.txt', 'one\ntwo\n');
    write(dir, 'b.txt', 'bee\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'task');
    const sha = git(dir, 'rev-parse', 'HEAD');
    // A later, uncommitted edit must not appear in a commit-sourced payload.
    write(dir, 'late.txt', 'late\n');

    const out = await collectTaskChanges(info(dir, { headRef, commit: { sha, branch: 'moag/p' } }), noRedact, signal());
    assert.ok(out);
    assert.equal(out.source, 'commit');
    assert.match(out.commit_sha ?? '', /^[0-9a-f]{40}$/);
    assert.equal(out.commit_sha, sha);
    assert.equal(out.branch, 'moag/p');
    assert.equal(out.base_sha, headRef);
    assert.deepEqual(out.files.map((f) => [f.path, f.status]), [['a.txt', 'modified'], ['b.txt', 'added']]);
  });

  it('a repository with no commits uses EMPTY_TREE_REF and reports new files as added', async () => {
    const dir = newRepo();
    write(dir, 'first.txt', 'hello\n');
    const out = await collectTaskChanges(info(dir, { untrackedAtStart: [] }), noRedact, signal());
    assert.ok(out);
    assert.equal(out.base_sha, EMPTY_TREE_REF);
    assert.equal(out.branch, null);
    assert.deepEqual(out.files, [{ path: 'first.txt', status: 'added', binary: false, added: 1, removed: 0 }]);
  });

  it('returns null for a folder that is not a git work tree', async () => {
    const dir = tmp('moag-tc-nogit-');
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      write(dir, 'x.txt', 'x');
      assert.equal(await collectTaskChanges(info(dir), noRedact, signal()), null);
    } finally {
      if (prev === undefined) { delete process.env.GIT_CEILING_DIRECTORIES; } else { process.env.GIT_CEILING_DIRECTORIES = prev; }
    }
  });

  it('caps 600 files and a 200 KB diff: 500 files, ≤64 KB text, diff.truncated, true bytes', async () => {
    const dir = newRepo();
    const line = 'y'.repeat(399) + '\n';
    for (let i = 0; i < 600; i++) { write(dir, `f/${String(i).padStart(3, '0')}.txt`, line); }
    const out = await collectTaskChanges(info(dir, { untrackedAtStart: [] }), noRedact, signal());
    assert.ok(out?.diff);
    assert.equal(out.files.length, 500);
    assert.ok(Buffer.byteLength(out.diff.text, 'utf-8') <= TASK_CHANGES_LIMITS.maxDiffBytes);
    assert.equal(out.diff.truncated, true);
    assert.ok(out.diff.bytes > 65_536 * 3, `bytes ${out.diff.bytes}`);
    assert.ok(!('truncated' in out));
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= TASK_CHANGES_LIMITS.maxEventJsonBytes);
  });

  it('501 tiny files: only the file cap trips, and diff.truncated says so', async () => {
    const dir = newRepo();
    for (let i = 0; i < 501; i++) { write(dir, `f/${i}.txt`, 'x\n'); }
    const out = await collectTaskChanges(info(dir, { untrackedAtStart: [] }), noRedact, signal());
    assert.ok(out?.diff);
    assert.equal(out.files.length, 500);
    assert.ok(out.diff.bytes < 65_536);
    assert.equal(out.diff.truncated, true);
  });

  it('a throwing redactor gives diff null + diff_error with files intact', async () => {
    const dir = newRepo();
    write(dir, 'a.txt', 'a\n');
    const throwing: Redactor = { redact: () => { throw new Error('boom'); } };
    const out = await collectTaskChanges(info(dir, { untrackedAtStart: [] }), throwing, signal());
    assert.ok(out);
    assert.equal(out.diff, null);
    assert.equal(out.diff_error, 'redaction failed');
    assert.deepEqual(out.files.map((f) => f.path), ['a.txt']);
  });

  it('a planted secret never reaches the payload', async () => {
    const dir = newRepo();
    const secret = 'sk-ant-api03-' + 'Q'.repeat(40);
    write(dir, 'config.js', `const key = '${secret}';\n`);
    const out = await collectTaskChanges(info(dir, { untrackedAtStart: [] }), noRedact, signal());
    assert.ok(out?.diff);
    assert.ok(!JSON.stringify(out).includes(secret));
    assert.equal(out.diff.redactions, 1);
  });

  it('only Completed/Failed tasks produce a payload', async () => {
    const dir = newRepo();
    assert.equal(await collectTaskChanges(info(dir, { status: TaskStatus.Skipped }), noRedact, signal()), null);
  });

  it('an already-aborted signal resolves null without spawning', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const out = await collectTaskChanges(info(process.cwd()), noRedact, ac.signal, async () => { calls++; return null; });
    assert.equal(out, null);
    assert.equal(calls, 0);
  });

  it('an abort mid-collection resolves null', async () => {
    const ac = new AbortController();
    const out = await collectTaskChanges(info(process.cwd()), noRedact, ac.signal, async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') { ac.abort(); return { stdout: 'true\n', overflow: false }; }
      return null;
    });
    assert.equal(out, null);
  });
});

describe('task-changes — pure helpers', () => {
  it('truncateUtf8 never splits a multi-byte character', () => {
    const s = 'ab€'; // € is 3 bytes: total 5
    assert.equal(truncateUtf8(s, 5), s);
    assert.equal(truncateUtf8(s, 4), 'ab');
    assert.equal(truncateUtf8(s, 3), 'ab');
    assert.equal(truncateUtf8(s, 2), 'ab');
    assert.equal(truncateUtf8('😀x', 3), '');
  });

  it('parseNumstatZ reads renames as A\\tR\\t\\0old\\0new\\0', () => {
    assert.deepEqual(parseNumstatZ('3\t1\t\0old.txt\0new.txt\0-\t-\tbin.png\0'), [
      { path: 'new.txt', old_path: 'old.txt', binary: false, added: 3, removed: 1 },
      { path: 'bin.png', binary: true, added: null, removed: null },
    ]);
  });

  it('parseNameStatusZ maps every status letter', () => {
    assert.deepEqual(parseNameStatusZ('A\0a\0M\0m\0T\0t\0U\0u\0D\0d\0R087\0o\0n\0C100\0src\0copy\0X\0x\0'), [
      { status: 'added', path: 'a' },
      { status: 'modified', path: 'm' },
      { status: 'modified', path: 't' },
      { status: 'modified', path: 'u' },
      { status: 'deleted', path: 'd' },
      { status: 'renamed', path: 'n', old_path: 'o' },
      { status: 'added', path: 'copy' },
      { status: 'modified', path: 'x' },
    ]);
  });

  it('fitEventSize shrinks an oversized payload and sets diff.truncated', () => {
    const p: TaskChangesPayload = {
      task_id: 't', status: 'completed', source: 'worktree', base_sha: EMPTY_TREE_REF, commit_sha: null, branch: null,
      files: [{ path: 'a', status: 'added', binary: false, added: 1, removed: 0 }],
      diff: { text: 'z'.repeat(300_000), truncated: false, bytes: 300_000, redactions: 0 },
    };
    const out = fitEventSize(p);
    assert.ok(Buffer.byteLength(JSON.stringify({ event: 'task-changes', ...out })) <= TASK_CHANGES_LIMITS.maxEventJsonBytes);
    assert.equal(out.diff?.truncated, true);
    assert.equal(out.files.length, 1);
    assert.ok(!('truncated' in out));
    // The input is not mutated.
    assert.equal(p.diff?.truncated, false);
  });

  it('fits under ONOSOO\'s per-event data cap: the diff goes first, then files from the end', () => {
    assert.equal(TASK_CHANGES_LIMITS.maxEventJsonBytes, 90_000);
    const files = Array.from({ length: 500 }, (_, i) => ({
      path: `src/${'deep/'.repeat(30)}file-${i}.ts`, status: 'modified' as const, binary: false, added: 1, removed: 1,
    }));
    const p: TaskChangesPayload = {
      task_id: 't', status: 'completed', source: 'worktree', base_sha: EMPTY_TREE_REF, commit_sha: null, branch: null,
      files, diff: { text: 'q'.repeat(65_536), truncated: false, bytes: 65_536, redactions: 0 },
    };
    const out = fitEventSize(p);
    assert.ok(Buffer.byteLength(JSON.stringify({ event: 'task-changes', ...out })) <= 90_000);
    assert.equal(out.diff?.text, '', 'the diff is emptied before any file is dropped');
    assert.ok(out.files.length > 0 && out.files.length < 500);
    assert.deepEqual(out.files, files.slice(0, out.files.length), 'files are dropped from the end');
    assert.equal(out.diff?.truncated, true);
  });

  it('fitEventSize leaves a small payload untouched', () => {
    const p: TaskChangesPayload = {
      task_id: 't', status: 'failed', source: 'worktree', base_sha: EMPTY_TREE_REF, commit_sha: null, branch: null,
      files: [], diff: { text: 'small', truncated: false, bytes: 5, redactions: 0 },
    };
    assert.equal(fitEventSize(p), p);
  });
});
