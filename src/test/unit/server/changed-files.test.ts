// ─── Changed files at the ship gate — collector and stored-document parser ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  CHANGED_FILES_LIMIT,
  ChangedFilesDoc,
  collectChangedFiles,
  parseChangedFilesDoc,
} from '../../../server/changed-files';
import { execFileAsync } from '../../../utils/exec-file';
import type { ExecFn } from '../../../server/projects';

const exec: ExecFn = (cmd, args, opts) => execFileAsync(cmd, args, opts);

/** A temp repository with one commit, or null when git cannot be spawned here. */
function makeRepo(): { dir: string; head: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-changed-'));
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim();
  try {
    git('init', '-q');
  } catch (err) {
    if (/EPERM|ENOENT/.test(String((err as Error).message))) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
    throw err;
  }
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\ny\n');
  fs.writeFileSync(path.join(dir, 'old-name.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, head: git('rev-parse', 'HEAD') };
}

const rowOf = (doc: ChangedFilesDoc, p: string) => doc.files.find((f) => f.path === p);

describe('server/changed-files', function () {
  this.timeout(30000);
  let repo: { dir: string; head: string } | null = null;
  beforeEach(function () {
    repo = makeRepo();
    if (!repo) { this.skip(); }
  });
  afterEach(() => { if (repo) { fs.rmSync(repo.dir, { recursive: true, force: true }); } });

  it('lists modified, binary, untracked, deleted and renamed files with their counts, and leaves .moag out', async () => {
    const { dir, head } = repo!;
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nB\nc\nd\n');
    fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    execFileSync('git', ['-C', dir, 'add', 'logo.bin']);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'l1\nl2\nl3');
    fs.rmSync(path.join(dir, 'gone.txt'));
    execFileSync('git', ['-C', dir, 'mv', 'old-name.txt', 'new-name.txt']);
    fs.mkdirSync(path.join(dir, '.moag'));
    fs.writeFileSync(path.join(dir, '.moag', 'x'), 'internal\n');
    // Windows refuses < and > in a file name; the parser test covers such a path there.
    const odd = process.platform === 'win32' ? null : '<script>alert(1)</script>.txt';
    if (odd) { fs.writeFileSync(path.join(dir, odd), 'x\n'); }

    const doc = await collectChangedFiles(dir, head, exec);
    assert.equal(doc.collected, true, JSON.stringify(doc));
    const d = doc as ChangedFilesDoc;
    assert.equal(d.baseRef, head);
    assert.equal(d.emptyTreeBase, false);
    assert.deepEqual(rowOf(d, 'keep.txt'), { path: 'keep.txt', added: 2, removed: 1, binary: false, untracked: false });
    assert.equal(rowOf(d, 'logo.bin')!.binary, true);
    assert.equal(rowOf(d, 'logo.bin')!.added, null);
    assert.deepEqual(rowOf(d, 'new.txt'), { path: 'new.txt', added: 3, removed: null, binary: false, untracked: true });
    assert.equal(rowOf(d, 'gone.txt')!.deleted, true);
    assert.equal(rowOf(d, 'gone.txt')!.removed, 2);
    assert.equal(rowOf(d, 'new-name.txt')!.renamedFrom, 'old-name.txt');
    assert.ok(!d.files.some((f) => f.path.startsWith('.moag')), '.moag is never listed');
    if (odd) { assert.ok(rowOf(d, odd), 'an odd path is kept verbatim'); }
    assert.equal(d.total, d.files.length);
    assert.deepEqual(d.files.map((f) => f.path), [...d.files.map((f) => f.path)].sort());
  });

  it('a file git was told to ignore is still listed: skip-worktree, assume-unchanged, .git/info/exclude and a global excludes file', async () => {
    const { dir, head } = repo!;
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
    // Edited after the index was told to look away: git diff alone reports nothing for either.
    git('update-index', '--skip-worktree', 'keep.txt');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\nsecret\n');
    git('update-index', '--assume-unchanged', 'old-name.txt');
    fs.writeFileSync(path.join(dir, 'old-name.txt'), 'rewritten\n');
    // Hidden by an excludes source that leaves no trace in the tree.
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'sneaky.txt\n');
    fs.writeFileSync(path.join(dir, 'sneaky.txt'), 'one\ntwo\n');
    const globalExcludes = path.join(dir, '..', `${path.basename(dir)}-excludes`);
    fs.writeFileSync(globalExcludes, 'global.txt\n');
    git('config', 'core.excludesFile', globalExcludes);
    fs.writeFileSync(path.join(dir, 'global.txt'), 'g\n');
    // A .gitignore in the tree still decides, and is itself a listed change.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'i\n');
    try {
      const d = await collectChangedFiles(dir, head, exec) as ChangedFilesDoc;
      assert.equal(d.collected, true, JSON.stringify(d));
      assert.deepEqual(rowOf(d, 'keep.txt'), { path: 'keep.txt', added: null, removed: null, binary: false, untracked: false, hiddenFromGit: true });
      assert.equal(rowOf(d, 'old-name.txt')!.hiddenFromGit, true);
      assert.deepEqual(rowOf(d, 'sneaky.txt'), { path: 'sneaky.txt', added: 2, removed: null, binary: false, untracked: true });
      assert.equal(rowOf(d, 'global.txt')!.untracked, true);
      assert.ok(rowOf(d, '.gitignore'), 'the .gitignore edit is listed');
      assert.equal(rowOf(d, 'ignored.txt'), undefined, '.gitignore still ignores');
      assert.equal(rowOf(d, 'gone.txt'), undefined, 'an unflagged, unchanged file is not listed');
      assert.equal(parseChangedFilesDoc(JSON.parse(JSON.stringify(d)))!.files.find((f) => f.path === 'keep.txt')!.hiddenFromGit, true);
    } finally {
      fs.rmSync(globalExcludes, { force: true });
    }
  });

  it('a flagged path that is not on disk (sparse checkout) hides nothing', async () => {
    const { dir, head } = repo!;
    execFileSync('git', ['-C', dir, 'update-index', '--skip-worktree', 'gone.txt']);
    fs.rmSync(path.join(dir, 'gone.txt'));
    const d = await collectChangedFiles(dir, head, exec) as ChangedFilesDoc;
    assert.equal(d.collected, true);
    assert.equal(rowOf(d, 'gone.txt'), undefined);
  });

  it('a null base diffs against the empty tree: every file counts as added', async () => {
    const doc = await collectChangedFiles(repo!.dir, null, exec) as ChangedFilesDoc;
    assert.equal(doc.collected, true);
    assert.equal(doc.emptyTreeBase, true);
    assert.equal(doc.baseRef, null);
    assert.deepEqual(rowOf(doc, 'keep.txt'), { path: 'keep.txt', added: 3, removed: 0, binary: false, untracked: false });
  });

  it('caps the rows at 500 while total counts every file', async () => {
    const { dir, head } = repo!;
    for (let i = 0; i < CHANGED_FILES_LIMIT + 5; i++) { fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x\n'); }
    const doc = await collectChangedFiles(dir, head, exec) as ChangedFilesDoc;
    assert.equal(doc.total, CHANGED_FILES_LIMIT + 5);
    assert.equal(doc.files.length, CHANGED_FILES_LIMIT);
    // The totals cover every file, the unlisted five included.
    assert.deepEqual(doc.totals, { added: CHANGED_FILES_LIMIT + 5, removed: 0, binary: 0, hiddenFromGit: 0, uncounted: 0 });
    assert.deepEqual(parseChangedFilesDoc(JSON.parse(JSON.stringify(doc)))!.totals, doc.totals);
  });

  it('the totals add tracked and untracked lines, and count binary files apart', async () => {
    const { dir, head } = repo!;
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nB\nc\nd\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'l1\nl2\nl3\n');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 0]));
    const doc = await collectChangedFiles(dir, head, exec) as ChangedFilesDoc;
    assert.deepEqual(doc.totals, { added: 2 + 3, removed: 1, binary: 1, hiddenFromGit: 0, uncounted: 0 });
  });

  it('an unsafe base is refused before git runs', async () => {
    let called = false;
    const spy: ExecFn = async (...args) => { called = true; return exec(...args); };
    for (const bad of ['HEAD', '--output=/tmp/x', 'abc', `${repo!.head};rm -rf /`]) {
      const doc = await collectChangedFiles(repo!.dir, bad, spy);
      assert.deepEqual(doc, { collected: false, reason: 'the diff base is not a commit id' });
    }
    assert.equal(called, false);
  });

  it('every git call is hardened: no shell, fsmonitor and hooks off, no external diff or textconv', async () => {
    const calls: string[][] = [];
    const spy: ExecFn = async (cmd, args, opts) => { calls.push([cmd, ...args]); return exec(cmd, args, opts); };
    await collectChangedFiles(repo!.dir, repo!.head, spy);
    assert.equal(calls.length, 4);
    for (const c of calls) {
      assert.equal(c[0], 'git');
      assert.deepEqual(c.slice(1, 9), [
        '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=',
      ]);
      assert.ok(c.includes(':(exclude).moag'));
      assert.ok(!c.includes('--exclude-standard'), 'never .git/info/exclude');
    }
    assert.ok(calls[2].includes('--exclude-per-directory=.gitignore'));
    assert.ok(calls[3].includes('ls-files') && calls[3].includes('-v'));
    assert.ok(calls[0].includes('--no-ext-diff') && calls[0].includes('--no-textconv'));
    assert.ok(calls[1].includes('--no-ext-diff'));
  });

  it('a failing git, or one that throws, is "not collected" — never 0 files, never a throw', async () => {
    const failing: ExecFn = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false });
    assert.deepEqual(await collectChangedFiles(repo!.dir, repo!.head, failing), { collected: false, reason: 'git could not list the changes' });
    const throwing: ExecFn = async () => { throw new Error('spawn EPERM'); };
    assert.deepEqual(await collectChangedFiles(repo!.dir, repo!.head, throwing), { collected: false, reason: 'git could not list the changes' });
  });
});

describe('server/changed-files — parseChangedFilesDoc', () => {
  const good = {
    collected: true, baseRef: 'a'.repeat(40), emptyTreeBase: false, total: 2,
    files: [
      { path: '<script>x</script>', added: 1, removed: 0, binary: false, untracked: false },
      { path: 'b', added: null, removed: null, binary: true, untracked: true, deleted: true, renamedFrom: 'a' },
    ],
  };

  it('accepts what the collector writes, verbatim', () => {
    assert.deepEqual(parseChangedFilesDoc(JSON.parse(JSON.stringify(good))), good);
    const full = { ...good, totals: { added: 1, removed: 0, binary: 1, hiddenFromGit: 0, uncounted: 0 }, baseKind: 'last-shipped' };
    assert.deepEqual(parseChangedFilesDoc(JSON.parse(JSON.stringify(full))), full);
  });

  it('refuses a malformed document', () => {
    const bad: unknown[] = [
      null, [], 'x', { ...good, collected: false }, { ...good, baseRef: 'HEAD' }, { ...good, total: -1 },
      { ...good, files: 'x' }, { ...good, files: [{ ...good.files[0], added: -1 }] },
      { ...good, files: [{ ...good.files[0], path: 3 }] }, { ...good, files: [{ ...good.files[0], deleted: false }] },
      { ...good, files: [{ ...good.files[0], hiddenFromGit: 'yes' }] },
      { ...good, total: 1 },
      { ...good, totals: 'x' }, { ...good, totals: { added: 1, removed: 0, binary: 0, hiddenFromGit: 0 } },
      { ...good, totals: { added: -1, removed: 0, binary: 0, hiddenFromGit: 0, uncounted: 0 } },
      { ...good, totals: { added: 0, removed: 0, binary: 2, hiddenFromGit: 0, uncounted: 1 } },
      { ...good, baseKind: 'yesterday' },
    ];
    for (const b of bad) { assert.equal(parseChangedFilesDoc(b), null, JSON.stringify(b)); }
  });

  it('refuses a list of more than 500 rows, and cuts long paths to 1000 characters', () => {
    const row = { path: 'x', added: 1, removed: 1, binary: false, untracked: false };
    assert.equal(parseChangedFilesDoc({ ...good, total: 501, files: Array.from({ length: 501 }, () => row) }), null);
    const long = parseChangedFilesDoc({ ...good, total: 1, files: [{ ...row, path: 'p'.repeat(5000) }] })!;
    assert.equal(long.files[0].path.length, 1000);
  });
});
