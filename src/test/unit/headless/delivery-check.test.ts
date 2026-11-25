// ─── `moag delivery-check`: read-only checks that a finished run can leave this machine ───
//
// git and `gh` are faked; the config folder is a throwaway directory. Nothing here pushes.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkProject, cmdDeliveryCheck, GitOutcome } from '../../../headless/delivery-check';

let dir: string;
let home: string;

function setup(projects: unknown[]): void {
  const cfg = path.join(home, 'moag');
  fs.mkdirSync(cfg, { recursive: true });
  // The loader wants each project to be the top level of a git repository.
  for (const p of projects as Array<{ path: string }>) { fs.mkdirSync(path.join(p.path, '.git'), { recursive: true }); }
  fs.writeFileSync(path.join(cfg, 'projects.json'), JSON.stringify({ version: 1, mode: 'local', remote_start: true, projects }));
}

function run(argv: string[], git: (a: string[]) => GitOutcome, gh = true): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = cmdDeliveryCheck(argv, {
    env: { XDG_CONFIG_HOME: home, APPDATA: home, HOME: home, USERPROFILE: home },
    platform: process.platform,
    homedir: () => home,
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    git: (args) => git(args),
    ghReady: () => gh,
  });
  return { code, out, err };
}

const good = (args: string[]): GitOutcome => (args[0] === 'remote' ? { ok: true, stdout: 'git@github.com-personal:o/shop.git' } : { ok: true, stdout: 'abc\trefs/heads/main' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-dcheck-'));
  home = path.join(dir, 'cfg');
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('checkProject', () => {
  it('a project with delivery off has nothing to check, and says how to turn it on', () => {
    const r = checkProject({ path: '/p', delivery: 'off' }, () => { throw new Error('git must not run'); }, () => { throw new Error('gh must not run'); });
    assert.deepEqual(r.problems, []);
    assert.match(r.notes[0], /Delivery is off/);
    assert.deepEqual(checkProject({ path: '/p' }, () => { throw new Error('no'); }, () => true).problems, []);
  });

  it('no origin is a problem with the command to fix it, and git is not asked to reach anything', () => {
    const calls: string[][] = [];
    const r = checkProject({ path: '/p', delivery: 'branch' }, (a) => { calls.push(a); return { ok: false, message: 'No such remote' }; }, () => true);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /git remote add origin/);
    assert.equal(calls.some((a) => a[0] === 'ls-remote'), false);
  });

  it('an unreachable remote gets the plain reason', () => {
    const r = checkProject({ path: '/p', delivery: 'branch' }, (a) => (a[0] === 'remote' ? { ok: true, stdout: 'git@github.com:o/r.git' } : { ok: false, message: 'ssh: connect to host github.com port 22: Connection timed out' }), () => true);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /port 443/);
  });

  it('draft-pr needs gh signed in; branch does not', () => {
    assert.match(checkProject({ path: '/p', delivery: 'draft-pr' }, good, () => false).problems[0], /gh auth login/);
    assert.deepEqual(checkProject({ path: '/p', delivery: 'branch' }, good, () => false).problems, []);
    assert.deepEqual(checkProject({ path: '/p', delivery: 'draft-pr' }, good, () => true).problems, []);
  });

  it('only reads: it asks for the remote address and lists heads, never pushes', () => {
    const calls: string[][] = [];
    checkProject({ path: '/p', delivery: 'draft-pr' }, (a) => { calls.push(a); return good(a); }, () => true);
    assert.deepEqual(calls.map((a) => a[0]), ['remote', 'ls-remote']);
    assert.equal(calls.some((a) => a.includes('push')), false);
  });
});

describe('moag delivery-check', () => {
  it('exits 0 and says every project can deliver when all is well', () => {
    setup([{ id: 'shop', name: 'Shop', kinds: ['web'], path: path.join(dir, 'shop'), delivery: 'draft-pr' }]);
    const r = run([], good);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Shop \(shop\), delivery draft-pr: OK/);
    assert.match(r.out, /Every checked project can deliver/);
  });

  it('exits 1 and lists what to fix when projects cannot deliver, still checking all of them', () => {
    setup([
      { id: 'a', name: 'A', kinds: ['web'], path: path.join(dir, 'a'), delivery: 'branch' },
      { id: 'b', name: 'B', kinds: ['web'], path: path.join(dir, 'b'), delivery: 'branch' },
    ]);
    const r = run([], (args) => (args[0] === 'remote' ? { ok: true, stdout: 'x' } : { ok: false, message: 'git@github.com: Permission denied (publickey).' }));
    assert.equal(r.code, 1);
    assert.match(r.out, /A \(a\), delivery branch: PROBLEM/);
    assert.match(r.out, /B \(b\), delivery branch: PROBLEM/);
    assert.match(r.out, /SSH key/);
    assert.match(r.out, /2 of 2 projects cannot deliver yet/);
  });

  it('checks one project when named, and refuses an unknown one with the known ids', () => {
    setup([
      { id: 'a', name: 'A', kinds: ['web'], path: path.join(dir, 'a'), delivery: 'branch' },
      { id: 'b', name: 'B', kinds: ['web'], path: path.join(dir, 'b'), delivery: 'branch' },
    ]);
    const one = run(['b'], good);
    assert.equal(one.code, 0);
    assert.doesNotMatch(one.out, /A \(a\)/);
    const unknown = run(['zzz'], good);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /Known: a, b/);
  });

  it('exits 2 with a hint when nothing is approved yet, and for a bad option', () => {
    const none = run([], good);
    assert.equal(none.code, 2);
    assert.match(none.err, /moag init/);
    assert.equal(run(['--push'], good).code, 2);
    assert.equal(run(['a', 'b'], good).code, 2);
  });
});
