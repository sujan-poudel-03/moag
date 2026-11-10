// ─── project-identity: the path-free project key of protocol v1.2 ───

import { strict as assert } from 'assert';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as sinon from 'sinon';
import {
  GitResult, IDENTITY_GIT_BACKSTOP_MS, IDENTITY_GIT_TIMEOUT_MS, IdentityGitRunner, MAX_MULTI_SCAN, multiKey, normaliseRemote, ProjectIdentity,
  ProjectIdentityCache, resolveProjectIdentity,
} from '../../../headless/project-identity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function hasGitAtOrAbove(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) { return true; }
    const parent = path.dirname(cur);
    if (parent === cur) { return false; }
    cur = parent;
  }
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A git stub answering by the first argument; records every call. */
function stubGit(answers: Record<string, GitResult>): IdentityGitRunner & { calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const fn = (async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    return answers[args[0]] ?? { ok: false, stdout: '' };
  }) as IdentityGitRunner & { calls: Array<{ cwd: string; args: string[] }> };
  fn.calls = calls;
  return fn;
}

const REPO = (shallow = false): GitResult => ({ ok: true, stdout: `true\n${shallow ? 'true' : 'false'}\n` });
const NO_ORIGIN: GitResult = { ok: false, stdout: '' };

// ─── normaliseRemote ───

describe('project identity — normaliseRemote', () => {
  const SAME = [
    'git@github.com:Owner/Repo.git',
    'https://user:tok@github.com/owner/repo',
    'ssh://git@github.com:22/owner/repo.git',
    'https://GitHub.com/Owner/Repo/',
    'git://github.com/owner/repo.git',
  ];
  for (const url of SAME) {
    it(`${url} → git:github.com/owner/repo`, () => {
      assert.equal(normaliseRemote(url)?.key, 'git:github.com/owner/repo');
    });
  }

  it('keeps the path case in repo_url and lower-cases the host', () => {
    assert.equal(normaliseRemote('git@github.com:Owner/Repo.git')?.repoUrl, 'https://github.com/Owner/Repo');
    assert.equal(normaliseRemote('https://GitHub.com/Owner/Repo/')?.repoUrl, 'https://github.com/Owner/Repo');
  });

  for (const local of ['/srv/x.git', 'C:\\x', 'C:/x', '\\\\server\\share\\x', './x', '../x', 'file:///srv/x.git', '~/x', 'host::path']) {
    it(`a local remote ${local} is never a git: key`, () => {
      assert.equal(normaliseRemote(local), null);
    });
  }

  it('rejects a non-numeric port, an IPv6 host, an unknown scheme, whitespace and bad paths', () => {
    assert.equal(normaliseRemote('ssh://git@github.com:abc/owner/repo.git'), null);
    assert.equal(normaliseRemote('ssh://git@[::1]/owner/repo.git'), null);
    assert.equal(normaliseRemote('ftp://github.com/owner/repo'), null);
    assert.equal(normaliseRemote('https://github.com/owner/re po'), null);
    assert.equal(normaliseRemote('https://github.com/owner/../repo'), null);
    assert.equal(normaliseRemote('https://github.com/owner//repo'), null);
    assert.equal(normaliseRemote('https://github.com/'), null);
    assert.equal(normaliseRemote('https://github.com'), null);
    assert.equal(normaliseRemote(''), null);
  });

  for (const leaky of [
    'https://github.com/o/r?private_token=abc123def',
    'https://github.com/o/r#frag',
    'ssh://localhost/C:/Users/x/r.git',
    'localhost:/home/x/r.git',
    'git@127.0.0.1:o/r.git',
    'https://user:123/abc@github.com/o/r',
    'https://127.8.9.10/o/r',
    'https://0.0.0.0/o/r',
    'ssh://git@LOCALHOST/o/r.git',
    'ssh://git@example.com/C:/Users/x/r.git',
    'git@github.com:o/r@x.git',
  ]) {
    it(`a remote that could leak a token or a local path (${leaky}) is null`, () => {
      assert.equal(normaliseRemote(leaky), null);
    });
  }

  it('a token URL leaves the credential in no field', () => {
    const r = normaliseRemote('https://user:tok@github.com/owner/repo');
    assert.ok(r);
    assert.equal(JSON.stringify(r).includes('tok'), false);
    assert.equal(JSON.stringify(r).includes('user'), false);
  });

  it('a key over 255 characters is not used', () => {
    assert.equal(normaliseRemote(`https://github.com/owner/${'r'.repeat(300)}`), null);
  });
});

// ─── multiKey ───

describe('project identity — multiKey', () => {
  it('is order independent and a sha256 of the sorted keys joined with newlines', () => {
    const keys = ['root:' + SHA_B, 'git:github.com/a/b'];
    const expected = 'multi:' + crypto.createHash('sha256').update('git:github.com/a/b\nroot:' + SHA_B).digest('hex');
    assert.equal(multiKey(keys), expected);
    assert.equal(multiKey([...keys].reverse()), expected);
    assert.match(expected, /^multi:[0-9a-f]{64}$/);
  });
});

// ─── resolveProjectIdentity with a stubbed git ───

describe('project identity — resolver (stubbed git)', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('moag-ident-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('an origin gives a git: key and repo_url', async () => {
    const git = stubGit({ 'rev-parse': REPO(), remote: { ok: true, stdout: 'git@github.com:Owner/Repo.git\n' } });
    assert.deepEqual(await resolveProjectIdentity(dir, { git }), { project_key: 'git:github.com/owner/repo', repo_url: 'https://github.com/Owner/Repo' });
  });

  it('two roots and no origin: root: plus the smallest sha, lower-case, no repo_url', async () => {
    const git = stubGit({ 'rev-parse': REPO(), remote: NO_ORIGIN, 'rev-list': { ok: true, stdout: `${SHA_B.toUpperCase()}\r\n${SHA_A.toUpperCase()}\r\n` } });
    assert.deepEqual(await resolveProjectIdentity(dir, { git }), { project_key: 'root:' + SHA_A });
  });

  it('a local origin falls through to root:', async () => {
    const git = stubGit({ 'rev-parse': REPO(), remote: { ok: true, stdout: '/srv/x.git\n' }, 'rev-list': { ok: true, stdout: SHA_A + '\n' } });
    assert.deepEqual(await resolveProjectIdentity(dir, { git }), { project_key: 'root:' + SHA_A });
  });

  it('a shallow clone with no usable origin is absent; with an origin it is git:', async () => {
    const noOrigin = stubGit({ 'rev-parse': REPO(true), remote: NO_ORIGIN, 'rev-list': { ok: true, stdout: SHA_A + '\n' } });
    assert.equal(await resolveProjectIdentity(dir, { git: noOrigin }), null);
    assert.equal(noOrigin.calls.some((c) => c.args[0] === 'rev-list'), false);
    const withOrigin = stubGit({ 'rev-parse': REPO(true), remote: { ok: true, stdout: 'https://github.com/o/r.git' } });
    assert.equal((await resolveProjectIdentity(dir, { git: withOrigin }))?.project_key, 'git:github.com/o/r');
  });

  it('absent for: not a repo, unborn HEAD, git failing, garbage rev-parse, a 64-hex root', async () => {
    fs.mkdirSync(path.join(dir, 'plain'));
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({}) }), null, 'not a repo, no .git children');
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({ 'rev-parse': REPO(), remote: NO_ORIGIN, 'rev-list': { ok: false, stdout: '' } }) }), null, 'unborn');
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({ 'rev-parse': { ok: true, stdout: 'garbage' } }) }), null, 'garbage');
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({ 'rev-parse': { ok: true, stdout: 'true\n--is-shallow-repository\n' } }) }), null, 'old git');
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({ 'rev-parse': REPO(), remote: NO_ORIGIN, 'rev-list': { ok: true, stdout: 'c'.repeat(64) } }) }), null, '64-hex');
    assert.equal(await resolveProjectIdentity(dir, { git: stubGit({ 'rev-parse': REPO(), remote: NO_ORIGIN, 'rev-list': { ok: true, stdout: 'not-a-sha' } }) }), null, 'garbage roots');
  });

  it('never rejects when git throws or the folder is missing', async () => {
    const throwing: IdentityGitRunner = async () => { throw new Error('boom'); };
    assert.equal(await resolveProjectIdentity(dir, { git: throwing }), null);
    assert.equal(await resolveProjectIdentity(path.join(dir, 'missing'), { git: stubGit({}) }), null);
  });

  it(`a folder with more than ${MAX_MULTI_SCAN} entries still resolves, reading no more than ${MAX_MULTI_SCAN} of them`, async function () {
    this.timeout(30_000);
    for (let i = 0; i < MAX_MULTI_SCAN + 100; i++) { fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}`), ''); }
    fs.mkdirSync(path.join(dir, 'a-repo', '.git'), { recursive: true });
    let pulled = 0;
    const counting = {
      ...fs,
      promises: {
        ...fs.promises,
        opendir: async (p: string) => {
          const d = await fs.promises.opendir(p);
          const it = d[Symbol.asyncIterator]();
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => { const r = await it.next(); if (!r.done) { pulled++; } return r; },
              return: async () => { await it.return?.(); return { done: true, value: undefined }; },
            }),
          };
        },
      },
    };
    const mod: typeof import('../../../headless/project-identity') = proxyquire('../../../headless/project-identity', { fs: counting });
    // The root is not a repository; a child answers as one with an origin.
    const git: IdentityGitRunner = async (cwd, args) => {
      if (cwd === dir) { return { ok: false, stdout: '' }; }
      return args[0] === 'rev-parse' ? REPO() : { ok: true, stdout: 'git@github.com:o/a.git' };
    };
    const id = await mod.resolveProjectIdentity(dir, { git });
    assert.ok(pulled > 0);
    assert.ok(pulled <= MAX_MULTI_SCAN, `read ${pulled} entries`);
    // Whether a-repo fell inside the scanned entries depends on the file system's order; either way it resolves.
    assert.ok(id === null || id.project_key.startsWith('multi:'));
  });

  it('a folder git refuses while a .git sits at or above it is absent, and its children are not tried', async () => {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere\n');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(path.join(sub, 'child', '.git'), { recursive: true });
    const git = stubGit({});
    assert.equal(await resolveProjectIdentity(sub, { git }), null);
    assert.equal(git.calls.length, 1);
    assert.equal(git.calls[0].cwd, sub);
  });
});

// ─── The default runner: execFile, never a shell; the backstop; the env ───

describe('project identity — execFile git runner', () => {
  let dir: string;
  let clock: sinon.SinonFakeTimers | undefined;
  beforeEach(() => { dir = tmp('moag-ident-exec-'); });
  afterEach(() => { clock?.restore(); clock = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  function load(execFile: sinon.SinonStub): typeof import('../../../headless/project-identity') {
    return proxyquire('../../../headless/project-identity', {
      child_process: { execFile, spawn: sinon.stub(), execSync: sinon.stub(), execFileSync: sinon.stub() },
    });
  }

  it('a git that never exits resolves absent after the timeout and is killed', async () => {
    const kill = sinon.spy();
    const execFile = sinon.stub().returns({ kill });
    const mod = load(execFile);
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const p = mod.resolveProjectIdentity(dir).then((r) => { settled = true; return r; });
    await clock.tickAsync(IDENTITY_GIT_TIMEOUT_MS);
    assert.equal(settled, false);
    await clock.tickAsync(IDENTITY_GIT_BACKSTOP_MS + 10);
    assert.equal(await p, null);
    assert.ok(kill.calledWith('SIGKILL'));
    const [cmd, args, opts] = execFile.firstCall.args;
    assert.equal(cmd, 'git');
    assert.ok(Array.isArray(args));
    assert.deepEqual(args.slice(0, 2), ['--no-pager', 'rev-parse']);
    assert.equal(opts.timeout, IDENTITY_GIT_TIMEOUT_MS);
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.equal('shell' in opts, false);
  });

  it('a synchronous spawn throw resolves absent', async () => {
    const mod = load(sinon.stub().throws(new Error('spawn ENOENT')));
    assert.equal(await mod.resolveProjectIdentity(dir), null);
  });

  it('strips the env that redirects git, keeps GIT_CONFIG_GLOBAL, disables prompts', async () => {
    const execFile = sinon.stub().callsFake((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
      setImmediate(() => cb(new Error('exit 128'), ''));
      return { kill: () => undefined };
    });
    const mod = load(execFile);
    const env = {
      GIT_DIR: '/x/.git', GIT_WORK_TREE: '/x', GIT_CONFIG_PARAMETERS: "'a.b=c'", GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_GLOBAL: 'g', PATH: '/bin',
    };
    assert.equal(await mod.resolveProjectIdentity(dir, { env }), null);
    const seen = execFile.firstCall.args[2].env as NodeJS.ProcessEnv;
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      assert.equal(k in seen, false, k);
    }
    assert.equal(seen.GIT_CONFIG_GLOBAL, 'g');
    assert.equal(seen.PATH, '/bin');
    assert.equal(seen.GIT_TERMINAL_PROMPT, '0');
    assert.equal(seen.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(seen.LC_ALL, 'C');
    assert.equal(env.GIT_DIR, '/x/.git', 'the caller env is not mutated');
  });

  it('reads the origin through `git remote get-url origin`', async () => {
    const execFile = sinon.stub().callsFake((_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
      const sub = args[1];
      setImmediate(() => {
        if (sub === 'rev-parse') { cb(null, 'true\nfalse\n'); return; }
        if (sub === 'remote') { cb(null, 'https://github.com/o/r.git\n'); return; }
        cb(new Error('x'), '');
      });
      return { kill: () => undefined };
    });
    const mod = load(execFile);
    assert.equal((await mod.resolveProjectIdentity(dir))?.project_key, 'git:github.com/o/r');
    assert.deepEqual(execFile.secondCall.args[1], ['--no-pager', 'remote', 'get-url', 'origin']);
  });
});

// ─── Real git ───

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

describe('project identity — real git', function () {
  this.timeout(60_000);

  let base: string;
  let env: NodeJS.ProcessEnv;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  }

  function makeRepo(dir: string, origin?: string): void {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    if (origin) { git(dir, 'remote', 'add', 'origin', origin); }
  }

  before(function () {
    base = tmp('moag-ident-git-');
    const globalCfg = path.join(base, 'empty.gitconfig');
    fs.writeFileSync(globalCfg, '');
    env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) { delete env[k]; }
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
    });
    try {
      git(base, '--version');
    } catch (err) {
      if (isSpawnEperm(err) || (err as NodeJS.ErrnoException).code === 'ENOENT') { this.skip(); }
      throw err;
    }
  });

  after(() => { if (base) { fs.rmSync(base, { recursive: true, force: true }); } });

  it('origin → git: key, a subfolder → the same key, origin removed → root:, shallow without origin → absent', async () => {
    const repo = path.join(base, 'repo');
    makeRepo(repo, 'https://github.com/Owner/Repo.git');
    fs.mkdirSync(path.join(repo, 'sub'));

    assert.deepEqual(await resolveProjectIdentity(repo, { env }), { project_key: 'git:github.com/owner/repo', repo_url: 'https://github.com/Owner/Repo' });
    assert.equal((await resolveProjectIdentity(path.join(repo, 'sub'), { env }))?.project_key, 'git:github.com/owner/repo');

    git(repo, 'remote', 'remove', 'origin');
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
    assert.deepEqual(await resolveProjectIdentity(repo, { env }), { project_key: 'root:' + root });

    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(base, 'clone', '-q', '--depth', '1', pathToFileURL(repo).href, 'shallow');
    const shallow = path.join(base, 'shallow');
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository').trim(), 'true');
    git(shallow, 'remote', 'remove', 'origin');
    assert.equal(await resolveProjectIdentity(shallow, { env }), null);
  });

  it('a folder of repositories → multi: key with repos in name order', async function () {
    if (hasGitAtOrAbove(base)) { this.skip(); }
    const multi = path.join(base, 'multi');
    makeRepo(path.join(multi, 'frontend'));
    makeRepo(path.join(multi, 'backend'), 'git@github.com:Owner/Backend.git');
    fs.mkdirSync(path.join(multi, 'docs'));
    const frontRoot = git(path.join(multi, 'frontend'), 'rev-list', '--max-parents=0', 'HEAD').trim();

    const id = await resolveProjectIdentity(multi, { env });
    assert.ok(id);
    assert.equal(id.project_key, multiKey(['git:github.com/owner/backend', 'root:' + frontRoot]));
    assert.deepEqual(id.repos, [
      { dir: 'backend', key: 'git:github.com/owner/backend', repo_url: 'https://github.com/Owner/Backend' },
      { dir: 'frontend', key: 'root:' + frontRoot },
    ]);
    assert.equal(JSON.stringify(id).includes(base), false);
  });
});

// ─── ProjectIdentityCache ───

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A resolve stub whose calls stay pending until the test settles them. */
function manualResolve(): { fn: (dir: string) => Promise<ProjectIdentity | null>; calls: Array<{ dir: string; d: Deferred<ProjectIdentity | null> }>; inFlight: () => number; peak: () => number } {
  const calls: Array<{ dir: string; d: Deferred<ProjectIdentity | null> }> = [];
  let open = 0;
  let peak = 0;
  const fn = (dir: string): Promise<ProjectIdentity | null> => {
    const d = deferred<ProjectIdentity | null>();
    calls.push({ dir, d });
    open++;
    peak = Math.max(peak, open);
    return d.promise.finally(() => { open--; });
  };
  return { fn, calls, inFlight: () => open, peak: () => peak };
}

const ID_A: ProjectIdentity = { project_key: 'git:github.com/o/a' };
const ID_B: ProjectIdentity = { project_key: 'git:github.com/o/b' };

describe('project identity — ProjectIdentityCache', () => {
  it('dedupes a lookup in flight, then serves the fresh entry with no resolve', async () => {
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn });
    const p1 = cache.warm('/w/a');
    const p2 = cache.warm('/w/a');
    assert.equal(p1, p2);
    assert.equal(cache.peek('/w/a'), undefined);
    r.calls[0].d.resolve(ID_A);
    assert.deepEqual(await p1, ID_A);
    assert.deepEqual(cache.peek('/w/a'), ID_A);
    assert.deepEqual(await cache.warm('/w/a'), ID_A);
    assert.equal(r.calls.length, 1);
  });

  it('a stale entry re-resolves once while peek keeps the old value', async () => {
    let now = 0;
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn, now: () => now, ttlMs: 100 });
    const first = cache.warm('/w/a');
    r.calls[0].d.resolve(ID_A);
    await first;
    now = 150;
    const again = cache.warm('/w/a');
    void cache.warm('/w/a');
    assert.equal(r.calls.length, 2);
    assert.deepEqual(cache.peek('/w/a'), ID_A);
    r.calls[1].d.resolve(ID_B);
    assert.deepEqual(await again, ID_B);
    assert.deepEqual(cache.peek('/w/a'), ID_B);
  });

  it('runs at most maxConcurrent lookups at once and finishes them all', async () => {
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn, maxConcurrent: 4 });
    const all = Array.from({ length: 10 }, (_, i) => cache.warm(`/w/p${i}`));
    assert.equal(r.calls.length, 4);
    let settled = 0;
    while (settled < r.calls.length) {
      for (const c of r.calls.slice(settled)) { c.d.resolve(null); }
      settled = r.calls.length;
      await flush();
      assert.ok(r.inFlight() <= 4);
    }
    await Promise.all(all);
    assert.equal(r.calls.length, 10);
    assert.equal(r.peak(), 4);
  });

  it('priority jumps the queue, including for a lookup already queued', async () => {
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn, maxConcurrent: 1 });
    void cache.warm('/w/a');
    void cache.warm('/w/b');
    void cache.warm('/w/c');
    void cache.warm('/w/urgent', { priority: true });
    void cache.warm('/w/c', { priority: true });
    r.calls[0].d.resolve(null);
    await flush();
    assert.equal(path.basename(r.calls[1].dir), 'c');
    r.calls[1].d.resolve(null);
    await flush();
    assert.equal(path.basename(r.calls[2].dir), 'urgent');
  });

  it('within: a remembered entry at once (stale included, refreshed in the background)', async () => {
    let now = 0;
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn, now: () => now, ttlMs: 100 });
    const w = cache.warm('/w/a');
    r.calls[0].d.resolve(null);
    await w;
    assert.equal(await cache.within('/w/a', 10), null);
    assert.equal(r.calls.length, 1);
    now = 500;
    assert.equal(await cache.within('/w/a', 10), null);
    assert.equal(r.calls.length, 2, 'stale → one background refresh');
  });

  it('within: a lookup in flight that lands inside the window', async () => {
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn });
    const p = cache.within('/w/a', 1_000);
    setTimeout(() => r.calls[0].d.resolve(ID_A), 5);
    assert.deepEqual(await p, ID_A);
  });

  it('within: a timeout resolves null and the late result still lands in the cache', async () => {
    const r = manualResolve();
    const cache = new ProjectIdentityCache({ resolve: r.fn });
    assert.equal(await cache.within('/w/a', 20), null);
    assert.equal(cache.peek('/w/a'), undefined);
    r.calls[0].d.resolve(ID_A);
    await flush();
    assert.deepEqual(cache.peek('/w/a'), ID_A);
  });

  it('a rejecting or throwing resolve stores null with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejecting = new ProjectIdentityCache({ resolve: () => Promise.reject(new Error('boom')) });
      assert.equal(await rejecting.warm('/w/a'), null);
      assert.equal(rejecting.peek('/w/a'), null);
      assert.equal(await rejecting.within('/w/b', 100), null);
      const throwing = new ProjectIdentityCache({ resolve: () => { throw new Error('sync boom'); } });
      assert.equal(await throwing.warm('/w/a'), null);
      await flush();
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const cache = new ProjectIdentityCache({ resolve: async () => ID_A, maxEntries: 2 });
    await cache.warm('/w/1');
    await cache.warm('/w/2');
    await cache.warm('/w/3');
    assert.equal(cache.peek('/w/1'), undefined);
    assert.deepEqual(cache.peek('/w/3'), ID_A);
  });
});
