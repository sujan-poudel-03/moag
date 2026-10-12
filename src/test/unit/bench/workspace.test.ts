import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  prepareWorkspace, runCommand, runGates, gatesGreen, cloneGuardProblem, cloneSourceTraces, BenchWorkspaceError,
} from '../../../bench/workspace';
import { Scenario } from '../../../bench/scenario';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid'];

function scenarioWith(over: Partial<Scenario>): Scenario {
  return {
    file: '/x/scenario.json', dir: '/x', name: 't', description: '', repo: { kind: 'template', templateDir: '/x/template' },
    setupCommands: [], stack: 'node-ts', engine: 'claude', budgetUsd: 1, perCallCapUsd: 1, minVersionUsd: 1, reserveFactor: 1.5,
    versionTimeoutMin: 1, passEnv: [], gateCommands: ['true'], gateTimeoutMs: 10_000, allowedCommands: [], environmentProbes: [], versions: [], ...over,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

describe('bench workspace', function () {
  this.timeout(30000);
  let tmp: string;

  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-ws-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a template becomes a fresh git repo with exactly one commit, then the setup commands run', async function () {
    if (!hasGit()) { this.skip(); return; }
    const template = path.join(tmp, 'template');
    fs.mkdirSync(path.join(template, 'src'), { recursive: true });
    fs.writeFileSync(path.join(template, 'README.md'), '# t\n');
    fs.writeFileSync(path.join(template, 'src', 'a.txt'), 'a\n');
    const root = path.join(tmp, 'workspaces');
    let ws;
    try {
      ws = await prepareWorkspace(scenarioWith({ repo: { kind: 'template', templateDir: template }, setupCommands: ['node -e "require(\'fs\').writeFileSync(\'setup.txt\',\'ok\')"'] }), root, 'proj');
    } catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.equal(ws.dir, path.join(root, 'proj'));
    assert.ok(fs.existsSync(path.join(ws.dir, '.git')));
    assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ws.dir }).toString().trim(), '1');
    assert.match(ws.head ?? '', /^[0-9a-f]{40}$/);
    assert.equal(fs.readFileSync(path.join(ws.dir, 'src', 'a.txt'), 'utf-8'), 'a\n');
    assert.equal(ws.setup.length, 1);
    assert.equal(fs.readFileSync(path.join(ws.dir, 'setup.txt'), 'utf-8'), 'ok');
    await assert.rejects(() => prepareWorkspace(scenarioWith({ repo: { kind: 'template', templateDir: template } }), root, 'proj'), /already exists/);
  });

  it('a failing setup command fails the preparation', async function () {
    if (!hasGit()) { this.skip(); return; }
    const template = path.join(tmp, 'template');
    fs.mkdirSync(template);
    fs.writeFileSync(path.join(template, 'f'), 'x');
    await assert.rejects(
      () => prepareWorkspace(scenarioWith({ repo: { kind: 'template', templateDir: template }, setupCommands: ['node -e "process.exit(7)"'] }), path.join(tmp, 'ws'), 'p'),
      (err: unknown) => err instanceof BenchWorkspaceError && /exited 7/.test(err.message),
    );
  });

  it('the clone guard refuses the source itself, a destination inside it, and one containing it', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    assert.ok(cloneGuardProblem(src, src));
    assert.ok(cloneGuardProblem(src, path.join(src, 'nested', 'ws')));
    assert.ok(cloneGuardProblem(path.join(tmp, 'a', 'src'), path.join(tmp, 'a')));
    assert.equal(cloneGuardProblem(src, path.join(tmp, 'elsewhere')), null);
    if (process.platform === 'win32') { assert.ok(cloneGuardProblem(src, path.join(src.toUpperCase(), 'ws')), 'case-insensitive on Windows'); }
    await assert.rejects(
      () => prepareWorkspace(scenarioWith({ repo: { kind: 'clone', path: src, ref: 'main' } }), path.join(src, 'workspaces'), 'p'),
      /never the live working tree/,
    );
  });

  it('clones a local repo at a branch into a fresh dir and records its HEAD', async function () {
    if (!hasGit()) { this.skip(); return; }
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: src, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    g('init', '-b', 'main');
    fs.writeFileSync(path.join(src, 'a'), '1');
    g('add', '-A'); g(...GIT_ID, 'commit', '-m', 'one');
    g('checkout', '-b', 'feature');
    fs.writeFileSync(path.join(src, 'b'), '2');
    g('add', '-A'); g(...GIT_ID, 'commit', '-m', 'two');
    const featureHead = g('rev-parse', 'HEAD');
    g('checkout', 'main');
    fs.writeFileSync(path.join(src, 'uncommitted'), 'never cloned');
    const ws = await prepareWorkspace(scenarioWith({ repo: { kind: 'clone', path: src, ref: 'feature' } }), path.join(tmp, 'workspaces'), 'clone');
    assert.equal(ws.head, featureHead);
    assert.ok(fs.existsSync(path.join(ws.dir, 'b')));
    assert.equal(fs.existsSync(path.join(ws.dir, 'uncommitted')), false, 'uncommitted work in the source is excluded');
    // No remote points back at the live source: a push or tag push from the
    // workspace has nowhere to go.
    const remotes = execFileSync('git', ['remote', '-v'], { cwd: ws.dir, windowsHide: true }).toString().trim();
    assert.equal(remotes, '', `the clone keeps no remote (got: ${remotes})`);
    const srcBranches = g('branch', '--list');
    assert.throws(() => execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/pushed'], { cwd: ws.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(g('branch', '--list'), srcBranches, 'the source gained no branch');
    assert.throws(() => execFileSync('git', ['fetch', 'origin'], { cwd: ws.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), 'nothing to fetch from');
  });

  it('a clone keeps no path back to its source: no remote, no reflog entry, nothing in git metadata names it', async function () {
    if (!hasGit()) { this.skip(); return; }
    const src = path.join(tmp, 'live-repo');
    fs.mkdirSync(src);
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    g(src, 'init', '-b', 'main');
    fs.writeFileSync(path.join(src, 'a'), '1');
    g(src, 'add', '-A'); g(src, ...GIT_ID, 'commit', '-m', 'one');
    fs.writeFileSync(path.join(src, 'a'), '2');
    g(src, 'add', '-A'); g(src, ...GIT_ID, 'commit', '-m', 'two');
    const ws = await prepareWorkspace(scenarioWith({ repo: { kind: 'clone', path: src, ref: 'main' } }), path.join(tmp, 'workspaces'), 'clone');

    assert.equal(g(ws.dir, 'remote'), '');
    assert.equal(g(ws.dir, 'reflog'), '', 'the "clone: from <source>" reflog entry is gone');
    assert.deepEqual(cloneSourceTraces(ws.dir, src), []);
    // Independent of cloneSourceTraces: no file under .git/logs, nor the config, mentions the source folder.
    const texts = [fs.readFileSync(path.join(ws.dir, '.git', 'config'), 'utf-8')];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(path.join(d, e.name)); } else { texts.push(fs.readFileSync(path.join(d, e.name), 'utf-8')); }
      }
    };
    if (fs.existsSync(path.join(ws.dir, '.git', 'logs'))) { walk(path.join(ws.dir, '.git', 'logs')); }
    for (const t of texts) { assert.equal(t.includes('live-repo'), false, t.slice(0, 300)); }
    assert.equal(fs.existsSync(path.join(ws.dir, '.git', 'objects', 'info', 'alternates')), false, 'objects are copied, not borrowed from the source');

    // The clone is still a complete, usable repository.
    assert.equal(g(ws.dir, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(ws.head, g(src, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(ws.dir, 'b'), 'x');
    g(ws.dir, 'add', '-A'); g(ws.dir, ...GIT_ID, 'commit', '-m', 'three');
    assert.equal(g(ws.dir, 'rev-list', '--count', 'HEAD'), '3');
    assert.equal(g(src, 'rev-list', '--count', 'HEAD'), '2', 'the source is untouched');
  });

  it('cloneSourceTraces finds the source in a reflog, the config or an alternates file, whatever the separators', function () {
    const ws = path.join(tmp, 'ws');
    const src = path.join(tmp, 'live-repo');
    fs.mkdirSync(path.join(ws, '.git', 'logs', 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.git', 'objects', 'info'), { recursive: true });
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n\tbare = false\n');
    assert.deepEqual(cloneSourceTraces(ws, src), []);
    assert.deepEqual(cloneSourceTraces(path.join(tmp, 'no-such-clone'), src), [], 'a missing .git has no traces and does not throw');
    fs.writeFileSync(path.join(ws, '.git', 'logs', 'refs', 'heads', 'main'), `0000 1111 t <t@t> 1 +0000\tclone: from ${src.replace(/\\/g, '/')}\n`);
    assert.deepEqual(cloneSourceTraces(ws, src), ['logs/refs/heads/main']);
    fs.writeFileSync(path.join(ws, '.git', 'config'), `[remote "origin"]\n\turl = ${src}\n`);
    fs.writeFileSync(path.join(ws, '.git', 'objects', 'info', 'alternates'), `${path.join(src, '.git', 'objects')}\n`);
    assert.deepEqual(cloneSourceTraces(ws, src).sort(), ['config', 'logs/refs/heads/main', 'objects/info/alternates']);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(ws, '.git', 'config'), `[remote "origin"]\n\turl = ${src.toUpperCase()}\n`);
      assert.ok(cloneSourceTraces(ws, src).includes('config'), 'case-insensitive on Windows');
    }
  });

  it('runCommand reports the exit code, and runGates keeps going after a failure', async function () {
    let results;
    try {
      results = await runGates(['node -e "process.exit(3)"', 'node -e "console.log(\'hi\')"'], tmp, process.env, 20_000);
    } catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    if (/EPERM/.test(results[0].tail)) { this.skip(); return; }
    assert.equal(results[0].exitCode, 3);
    assert.equal(results[0].timedOut, false);
    assert.equal(results[1].exitCode, 0);
    assert.match(results[1].tail, /hi/);
    assert.equal(gatesGreen(results), false);
    assert.equal(gatesGreen([results[1]]), true);
    assert.equal(gatesGreen([]), false, 'no gates is never green');
  });

  it('a timed-out command is tree-killed and reports timedOut', async function () {
    const pidFile = path.join(tmp, 'pid.txt');
    const r = await runCommand(`node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 1e6)" "${pidFile}"`, tmp, process.env, 1500);
    if (/EPERM/.test(r.tail)) { this.skip(); return; }
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    assert.ok(pid > 0);
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) { await new Promise((res) => setTimeout(res, 50)); }
    assert.equal(alive(pid), false, 'no live child after the timeout');
  });

  it('a command that cannot start resolves with a null exit code', async () => {
    const r = await runCommand('definitely-not-a-command-xyz-123', tmp, process.env, 10_000);
    assert.notEqual(r.exitCode, 0);
  });
});
