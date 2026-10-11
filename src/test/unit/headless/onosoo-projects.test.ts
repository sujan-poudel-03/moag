// ─── ONOSOO approved projects loader ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ApprovedProjects, loadApprovedProjects, MAX_PROJECTS, PROJECT_ID_RE, PROJECTS_FILE,
} from '../../../headless/onosoo-projects';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A fake git top level: a directory with a `.git` directory in it. */
function repo(parent?: string, name = 'repo'): string {
  const dir = parent ? path.join(parent, name) : tmp('moag-proj-repo-');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function stateWith(doc: unknown, raw?: string): string {
  const stateDir = tmp('moag-proj-state-');
  fs.writeFileSync(path.join(stateDir, PROJECTS_FILE), raw ?? JSON.stringify(doc));
  return stateDir;
}

const v1 = (projects: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ version: 1, remote_start: false, daily_budget_usd: null, runner_user: null, projects, ...extra });

function load(doc: unknown, opts?: Parameters<typeof loadApprovedProjects>[1]): ApprovedProjects {
  return loadApprovedProjects(stateWith(doc), opts);
}

describe('ONOSOO approved projects — file level', () => {
  it('pins the exported constants', () => {
    assert.equal(PROJECTS_FILE, 'projects.json');
    assert.equal(MAX_PROJECTS, 200);
    assert.ok(PROJECT_ID_RE.test('web-app.v2_x'));
    assert.ok(!PROJECT_ID_RE.test('Web'));
    assert.ok(!PROJECT_ID_RE.test('-x'));
    assert.ok(!PROJECT_ID_RE.test('a'.repeat(65)));
  });

  it('a missing file is "nothing approved", with no error', () => {
    assert.deepEqual(loadApprovedProjects(tmp('moag-proj-state-')), {
      remoteStart: false, dailyBudgetUsd: null, runnerUser: null, projects: [], errors: [],
    });
  });

  it('a missing state dir is the same', () => {
    assert.deepEqual(loadApprovedProjects(path.join(os.tmpdir(), `moag-nope-${Date.now()}`)).errors, []);
  });

  for (const [label, raw] of [['invalid JSON', '{nope'], ['a non-object', '[1,2]'], ['null', 'null'], ['version 2', '{"version":2,"remote_start":true,"projects":[]}'], ['no version', '{"remote_start":true}']] as Array<[string, string]>) {
    it(`${label} → remote start off, no projects, exactly one error`, () => {
      const r = loadApprovedProjects(stateWith(null, raw));
      assert.equal(r.remoteStart, false);
      assert.deepEqual(r.projects, []);
      assert.equal(r.errors.length, 1, r.errors.join('\n'));
    });
  }

  it('an unreadable file (a directory named projects.json) → one error', () => {
    const stateDir = tmp('moag-proj-state-');
    fs.mkdirSync(path.join(stateDir, PROJECTS_FILE));
    const r = loadApprovedProjects(stateDir);
    assert.equal(r.remoteStart, false);
    assert.equal(r.errors.length, 1);
  });
});

describe('ONOSOO approved projects — settings', () => {
  it('remote_start true is the only way on', () => {
    const r = load(v1([], { remote_start: true }));
    assert.equal(r.remoteStart, true);
    assert.deepEqual(r.errors, []);
    assert.equal(load(v1([], { remote_start: false })).errors.length, 0);
  });

  for (const bad of ['true', 1, null, {}]) {
    it(`remote_start ${JSON.stringify(bad)} → off plus an error`, () => {
      const r = load(v1([], { remote_start: bad }));
      assert.equal(r.remoteStart, false);
      assert.equal(r.errors.length, 1);
    });
  }

  it('remote_start absent → off, no error', () => {
    const doc = v1([]);
    delete doc.remote_start;
    assert.deepEqual(load(doc).errors, []);
  });

  it('daily_budget_usd: a positive finite number is kept; null/absent silently null', () => {
    assert.equal(load(v1([], { daily_budget_usd: 12.5 })).dailyBudgetUsd, 12.5);
    const n = load(v1([], { daily_budget_usd: null }));
    assert.equal(n.dailyBudgetUsd, null);
    assert.deepEqual(n.errors, []);
    const doc = v1([]);
    delete doc.daily_budget_usd;
    assert.deepEqual(load(doc).errors, []);
  });

  for (const bad of [0, -5, '10', true, [5]]) {
    it(`daily_budget_usd ${JSON.stringify(bad)} → null plus an error`, () => {
      const r = load(v1([], { daily_budget_usd: bad }));
      assert.equal(r.dailyBudgetUsd, null);
      assert.equal(r.errors.length, 1);
    });
  }

  it('daily_budget_usd Infinity (written as 1e999) → null plus an error', () => {
    const r = loadApprovedProjects(stateWith(null, '{"version":1,"daily_budget_usd":1e999}'));
    assert.equal(r.dailyBudgetUsd, null);
    assert.equal(r.errors.length, 1);
  });

  it('runner_user: a plain account name is kept; null/absent silently null', () => {
    assert.equal(load(v1([], { runner_user: 'moag-runner' })).runnerUser, 'moag-runner');
    assert.equal(load(v1([], { runner_user: '_svc' })).runnerUser, '_svc');
    assert.deepEqual(load(v1([], { runner_user: null })).errors, []);
  });

  for (const bad of ['root', 'Admin', '1user', 'a'.repeat(33), 'bad user', 7]) {
    it(`runner_user ${JSON.stringify(bad)} → null plus an error`, () => {
      const r = load(v1([], { runner_user: bad }));
      assert.equal(r.runnerUser, null);
      assert.equal(r.errors.length, 1);
    });
  }
});

describe('ONOSOO approved projects — entries', () => {
  it('loads a valid entry with its realpath; kinds default to []; name trimmed and capped at 200', () => {
    const a = repo();
    const b = repo();
    const r = load(v1([
      { id: 'web', name: '  Web app  ', path: a, kinds: ['node', 'web'] },
      { id: 'api', name: 'x'.repeat(250), path: b },
    ]));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.projects, [
      { id: 'web', name: 'Web app', kinds: ['node', 'web'], path: fs.realpathSync(a) },
      { id: 'api', name: 'x'.repeat(200), kinds: [], path: fs.realpathSync(b) },
    ]);
  });

  it('projects not an array → an error and no projects', () => {
    const r = load(v1({ id: 'x' }));
    assert.deepEqual(r.projects, []);
    assert.equal(r.errors.length, 1);
  });

  it('201 entries: only the first 200 are read, with one error for the cut', () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, name: 'n', path: '/definitely/not/here' }));
    const r = load(v1(entries));
    assert.equal(r.errors.filter((e) => /first 200/.test(e)).length, 1);
    assert.equal(r.errors.filter((e) => /^p200:/.test(e)).length, 0, 'entry 201 was never examined');
    assert.equal(r.errors.length, 201);
  });

  const valid = (over: Record<string, unknown>): Record<string, unknown> => ({ id: 'ok', name: 'Ok', path: repo(), ...over });
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['an entry that is not an object', () => 'web', /^projects\[0\]: entry must be an object/],
    ['a bad id', () => valid({ id: 'Bad ID' }), /^projects\[0\]: id must match/],
    ['a missing id', () => valid({ id: undefined }), /^projects\[0\]: id/],
    ['a blank name', () => valid({ name: '   ' }), /^ok: name/],
    ['a non-string name', () => valid({ name: 5 }), /^ok: name/],
    ['kinds not an array', () => valid({ kinds: 'node' }), /^ok: kinds/],
    ['kinds with a non-string', () => valid({ kinds: ['node', 3] }), /^ok: kinds/],
    ['a relative path', () => valid({ path: 'repos/web' }), /^ok: path must be an absolute path/],
    ['a non-string path', () => valid({ path: 42 }), /^ok: path must be an absolute path/],
    ['a path that does not exist', () => valid({ path: path.join(tmp('moag-proj-x-'), 'gone') }), /^ok: path does not exist/],
    ['a path that is a file', () => { const d = tmp('moag-proj-f-'); const f = path.join(d, 'file'); fs.writeFileSync(f, ''); return valid({ path: f }); }, /^ok: path is not a directory/],
    ['a directory without .git', () => valid({ path: tmp('moag-proj-nogit-') }), /^ok: path is not the top level of a git repository/],
  ];
  for (const [label, entry, error] of cases) {
    it(`rejects ${label}, naming the entry and the reason, and keeps the others`, () => {
      const good = repo();
      const r = load(v1([entry(), { id: 'good', name: 'Good', path: good }]));
      assert.equal(r.errors.length, 1, r.errors.join('\n'));
      assert.match(r.errors[0], error);
      assert.deepEqual(r.projects.map((p) => p.id), ['good']);
    });
  }

  it('a .git FILE (a worktree or submodule top level) counts as a git top level', () => {
    const d = tmp('moag-proj-wt-');
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n');
    const r = load(v1([{ id: 'wt', name: 'Worktree', path: d }]));
    assert.deepEqual(r.errors, []);
    assert.equal(r.projects.length, 1);
  });

  it('a duplicated id rejects every entry with it', () => {
    const r = load(v1([
      { id: 'dup', name: 'A', path: repo() },
      { id: 'solo', name: 'S', path: repo() },
      { id: 'dup', name: 'B', path: repo() },
    ]));
    assert.deepEqual(r.projects.map((p) => p.id), ['solo']);
    assert.equal(r.errors.filter((e) => /^dup: .*more than one/.test(e)).length, 2);
  });

  it('overlapping paths (equal, or one inside the other) reject both', () => {
    const outer = repo();
    const inner = repo(outer, 'packages-web');
    const same = repo();
    const r = load(v1([
      { id: 'outer', name: 'O', path: outer },
      { id: 'inner', name: 'I', path: inner },
      { id: 'same-a', name: 'A', path: same },
      { id: 'same-b', name: 'B', path: same },
      { id: 'free', name: 'F', path: repo() },
    ]));
    assert.deepEqual(r.projects.map((p) => p.id), ['free']);
    assert.equal(r.errors.length, 4);
    assert.ok(r.errors.every((e) => /overlaps/.test(e)));
  });

  it('overlap uses path boundaries: /x/web and /x/web2 do not overlap', () => {
    const parent = tmp('moag-proj-bound-');
    const r = load(v1([
      { id: 'web', name: 'W', path: repo(parent, 'web') },
      { id: 'web2', name: 'W2', path: repo(parent, 'web2') },
    ]));
    assert.deepEqual(r.errors, []);
    assert.equal(r.projects.length, 2);
  });

  it('on win32, overlap is found case-insensitively across mixed-case real paths', () => {
    const outer = repo();
    const inner = repo(outer, 'Sub');
    // The injected realpath reports the inner repo in a different case, as Windows may.
    const realpath = (p: string): string => (p === inner ? fs.realpathSync(p).toUpperCase() : fs.realpathSync(p));
    const r = load(v1([
      { id: 'outer', name: 'O', path: outer },
      { id: 'inner', name: 'I', path: inner },
    ]), { platform: 'win32', realpath });
    assert.deepEqual(r.projects, []);
    assert.equal(r.errors.filter((e) => /overlaps/.test(e)).length, 2);

    // The same paths on a case-sensitive platform do not overlap (POSIX hosts only: the FS must allow it).
    if (process.platform !== 'win32') {
      const posix = load(v1([
        { id: 'outer', name: 'O', path: outer },
        { id: 'inner', name: 'I', path: inner },
      ]), { platform: 'linux', realpath });
      assert.equal(posix.projects.length, 2);
    }
  });

  it('a win32 drive path is absolute under the injected platform, and a posix path still resolves there', () => {
    const r = load(v1([{ id: 'w', name: 'W', path: 'Z:\\definitely\\missing' }]), { platform: 'win32' });
    assert.match(r.errors[0], /^w: path does not exist/, 'absolute under win32 rules, so the next check ran');
    const p = load(v1([{ id: 'w', name: 'W', path: 'Z:\\definitely\\missing' }]), { platform: 'linux' });
    assert.match(p.errors[0], /^w: path must be an absolute path/);
  });

  it('rejects a project that is, or is inside, the state dir', () => {
    const stateDir = tmp('moag-proj-state-');
    const insideState = repo(stateDir, 'nested');
    fs.mkdirSync(path.join(stateDir, '.git'));
    fs.writeFileSync(path.join(stateDir, PROJECTS_FILE), JSON.stringify(v1([
      { id: 'inside', name: 'In', path: insideState },
      { id: 'itself', name: 'It', path: stateDir },
    ])));
    const r = loadApprovedProjects(stateDir);
    assert.deepEqual(r.projects, []);
    assert.equal(r.errors.filter((e) => /state directory/.test(e)).length, 2);
  });

  it('rejects a project that contains the state dir', () => {
    const outer = repo();
    const stateDir = path.join(outer, 'cfg', 'moag');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, PROJECTS_FILE), JSON.stringify(v1([
      { id: 'outer', name: 'O', path: outer },
      { id: 'other', name: 'X', path: repo() },
    ])));
    const r = loadApprovedProjects(stateDir);
    assert.deepEqual(r.projects.map((p) => p.id), ['other']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^outer: .*state directory/);
  });

  it('never throws, even when the injected realpath does', () => {
    const r = load(v1([{ id: 'x', name: 'X', path: repo() }]), { realpath: () => { throw new Error('boom'); } });
    assert.deepEqual(r.projects, []);
    assert.match(r.errors[0], /^x: path could not be resolved/);
  });
});

describe('ONOSOO approved projects — load-time imports', () => {
  it('requiring the module loads no vscode and no child_process', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
    const original = Module._load;
    const requested: string[] = [];
    Module._load = function (request: string, ...rest: unknown[]): unknown {
      requested.push(request);
      return original.call(this, request, ...rest);
    };
    const id = require.resolve('../../../headless/onosoo-projects');
    try {
      delete require.cache[id];
      require(id);
    } finally {
      Module._load = original;
    }
    assert.ok(requested.length > 0, 'the hook saw the load');
    assert.ok(!requested.includes('vscode'), requested.join(', '));
    assert.ok(!requested.includes('child_process'), requested.join(', '));
    assert.deepEqual(requested.filter((r) => !['fs', 'path'].includes(r) && r !== id), []);
  });
});
