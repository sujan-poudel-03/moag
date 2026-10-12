import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  ProjectStore, ProjectInputError, resolveProjectPath, validateCloneUrl, cloneRepo, isGitRepo, gitTopLevel, isPathNested, intakeProject,
  cloneEnv, redactUrlUserinfo, ExecFn, PROJECTS_FILE, buildRepoListing, detectRepoEngineConfig, REPO_LISTING_MAX_PATHS,
  planNewRepo, NEW_REPO_IDENTITY, NEW_REPO_COMMIT_MESSAGE, createEmptyRepo,
} from '../../../server/projects';
import { execFileSync } from 'child_process';
import { ExecFileAsyncResult } from '../../../utils/exec-file';
const proxyquire = require('proxyquire').noCallThru();

const ok = (stdout = ''): ExecFileAsyncResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
/** A git stub where every `-C` dir is its own repository's top level. */
const repoRoot: ExecFn = async (_c, args) => ok(args.includes('--show-toplevel') ? `${args[args.indexOf('-C') + 1]}\n` : 'true');

function code(fn: () => unknown): string {
  try { fn(); } catch (e) {
    assert.ok(e instanceof ProjectInputError, `expected ProjectInputError, got ${String(e)}`);
    return e.code;
  }
  assert.fail('did not throw');
}

describe('projects', () => {
  let tmp: string;
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-proj-'));
    root = path.join(tmp, 'workspaces');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(root);
    fs.mkdirSync(dataDir);
    fs.mkdirSync(path.join(root, 'acme'));
    fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('resolveProjectPath', () => {
    it('resolves a folder inside the root to its realpath', () => {
      assert.equal(resolveProjectPath(root, 'acme'), fs.realpathSync.native(path.join(root, 'acme')));
      assert.equal(resolveProjectPath(root, 'nested/deep'), fs.realpathSync.native(path.join(root, 'nested', 'deep')));
    });

    it('rejects .. segments', () => {
      assert.equal(code(() => resolveProjectPath(root, '../data')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, 'acme/../../data')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, 'acme\\..\\..\\data')), 'invalid-path');
    });

    it('rejects absolute paths and the root itself', () => {
      assert.equal(code(() => resolveProjectPath(root, path.join(root, 'acme'))), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, '/etc')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, 'C:\\Windows')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, '\\\\server\\share')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, '.')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, './')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, '')), 'invalid-path');
      assert.equal(code(() => resolveProjectPath(root, 42)), 'invalid-path');
    });

    it('rejects non-existent paths and files', () => {
      assert.equal(code(() => resolveProjectPath(root, 'missing')), 'path-not-found');
      fs.writeFileSync(path.join(root, 'file.txt'), 'x');
      assert.equal(code(() => resolveProjectPath(root, 'file.txt')), 'not-a-directory');
    });

    it('rejects a symlink that escapes the root', function () {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') { this.skip(); }
        throw e;
      }
      assert.equal(code(() => resolveProjectPath(root, 'escape')), 'path-escape');
    });

    it('rejects a symlink back to the root itself', function () {
      try { fs.symlinkSync(root, path.join(root, 'self'), 'junction'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') { this.skip(); }
        throw e;
      }
      assert.equal(code(() => resolveProjectPath(root, 'self')), 'path-escape');
    });

    it('rejects a workspace that is already registered', () => {
      assert.equal(code(() => resolveProjectPath(root, 'acme', () => true)), 'workspace-registered');
    });
  });

  describe('validateCloneUrl', () => {
    it('accepts https and (when allowed) ssh', () => {
      assert.equal(validateCloneUrl('https://github.com/acme/checkout.git', { allowSsh: false }), 'https://github.com/acme/checkout.git');
      assert.equal(validateCloneUrl('ssh://git@github.com/acme/x.git', { allowSsh: true }), 'ssh://git@github.com/acme/x.git');
    });

    it('rejects file://, ext::, http, git@ scp-form, ssh when not allowed', () => {
      for (const bad of ['file:///etc/passwd', 'ext::sh -c x', 'ext::sh', 'http://h/r', 'git@github.com:a/b.git', 'ssh://h/r', 'javascript:alert(1)']) {
        assert.throws(() => validateCloneUrl(bad, { allowSsh: false }), ProjectInputError, bad);
      }
    });

    it('rejects a password in userinfo, leading dash, overlong and hostless', () => {
      assert.throws(() => validateCloneUrl('https://u:p@h/r', { allowSsh: false }), /password/);
      assert.throws(() => validateCloneUrl('-uhttps://h/r', { allowSsh: false }), ProjectInputError);
      assert.throws(() => validateCloneUrl('--upload-pack=touch /tmp/x', { allowSsh: false }), ProjectInputError);
      assert.throws(() => validateCloneUrl('https://h/' + 'a'.repeat(2048), { allowSsh: false }), ProjectInputError);
      assert.throws(() => validateCloneUrl('https://', { allowSsh: false }), ProjectInputError);
      assert.throws(() => validateCloneUrl(undefined, { allowSsh: false }), ProjectInputError);
    });

    it('redacts userinfo for storage', () => {
      assert.equal(redactUrlUserinfo('https://ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
      assert.equal(redactUrlUserinfo('https://github.com/a/b.git'), 'https://github.com/a/b.git');
    });
  });

  describe('cloneRepo', () => {
    it('passes a metacharacter URL as one literal argv element after --, never via a shell', async () => {
      const evil = 'https://h/r;id&&$(x)';
      const exec = sinon.stub<Parameters<ExecFn>, ReturnType<ExecFn>>().callsFake(async (_c, args) => {
        fs.mkdirSync(args[args.length - 1], { recursive: true });
        return ok();
      });
      await cloneRepo(evil, 'evil', { projectsRoot: root, allowSsh: false, serverEnv: { PATH: '/bin' }, exec });
      assert.equal(exec.calledOnce, true);
      const [cmd, args, opts] = exec.firstCall.args;
      assert.equal(cmd, 'git');
      const dashdash = args.indexOf('--');
      assert.ok(dashdash > 0);
      assert.equal(args[dashdash + 1], evil, 'URL is the single element after --');
      assert.equal(args.filter((a) => a.includes('$(x)')).length, 1);
      assert.deepEqual(args.slice(0, 7), ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--no-recurse-submodules', '--']);
      assert.equal(opts?.env?.GIT_TERMINAL_PROMPT, '0');
      assert.equal(opts?.env?.GIT_ALLOW_PROTOCOL, 'https');
      assert.equal(opts?.timeoutMs, 10 * 60 * 1000);
    });

    it('really reaches execFile with shell:false (end-to-end through execFileAsync)', async () => {
      const proxyquire = require('proxyquire').noCallThru();
      const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
      const execFileMod = proxyquire('../../../utils/exec-file', {
        child_process: {
          execFile: (cmd: string, args: string[], opts: Record<string, unknown>, cb: (e: null, o: string, er: string) => void) => {
            calls.push({ cmd, args, opts });
            fs.mkdirSync(args[args.length - 1], { recursive: true });
            setImmediate(() => cb(null, '', ''));
            return { pid: 1 };
          },
          execSync: () => '',
          spawn: () => { throw new Error('spawn must not be used'); },
        },
      });
      await cloneRepo('https://h/r;id&&$(x)', 'e2e', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: execFileMod.execFileAsync });
      assert.equal(calls[0].opts.shell, false);
      assert.ok(calls[0].args.includes('https://h/r;id&&$(x)'));
    });

    it('rejects a bad destination name before running git', async () => {
      const exec = sinon.stub().resolves(ok());
      for (const bad of ['../x', '.hidden', '-x', 'a/b', '', 'x'.repeat(65)]) {
        await assert.rejects(cloneRepo('https://h/r', bad, { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), ProjectInputError, bad);
      }
      assert.equal(exec.called, false);
    });

    it('rejects an invalid URL before running git', async () => {
      const exec = sinon.stub().resolves(ok());
      await assert.rejects(cloneRepo('file:///etc', 'x', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), ProjectInputError);
      assert.equal(exec.called, false);
    });

    it('removes a partial clone on failure', async () => {
      const exec: ExecFn = async (_c, args) => {
        fs.mkdirSync(args[args.length - 1], { recursive: true });
        fs.writeFileSync(path.join(args[args.length - 1], 'partial'), 'x');
        return { exitCode: 128, stdout: '', stderr: 'fatal: repository not found', timedOut: false };
      };
      await assert.rejects(cloneRepo('https://h/r', 'gone', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), /repository not found/);
      assert.equal(fs.existsSync(path.join(root, 'gone')), false);
    });

    it('refuses an existing destination', async () => {
      const exec = sinon.stub().resolves(ok());
      await assert.rejects(cloneRepo('https://h/r', 'acme', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), /already exists/);
      assert.equal(exec.called, false);
    });

    it('reserves the destination before git runs: a concurrent clone of the same name is 409 and never removes the winner', async () => {
      let release: () => void = () => { /* set below */ };
      const gate = new Promise<void>((r) => { release = r; });
      const seenAtExec: boolean[] = [];
      const slow: ExecFn = async (_c, args) => {
        const dest = args[args.length - 1];
        seenAtExec.push(fs.existsSync(dest));
        await gate;
        fs.writeFileSync(path.join(dest, 'README.md'), 'cloned');
        return ok();
      };
      const first = cloneRepo('https://h/a', 'same', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: slow });
      const failing: ExecFn = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not found', timedOut: false });
      await assert.rejects(cloneRepo('https://h/b', 'same', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: failing }),
        (e: unknown) => e instanceof ProjectInputError && e.code === 'dest-exists' && e.status === 409);
      release();
      const dest = await first;
      assert.deepEqual(seenAtExec, [true], 'the folder exists (reserved) when git starts');
      assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf-8'), 'cloned', 'the losing request removed nothing');
    });

    it('a failed clone removes only the folder it reserved; a pre-existing folder is never touched', async () => {
      fs.writeFileSync(path.join(root, 'acme', 'keep.txt'), 'mine');
      const exec = sinon.stub().resolves({ exitCode: 128, stdout: '', stderr: 'boom', timedOut: false });
      await assert.rejects(cloneRepo('https://h/r', 'acme', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), /already exists/);
      assert.equal(fs.readFileSync(path.join(root, 'acme', 'keep.txt'), 'utf-8'), 'mine');
      await assert.rejects(cloneRepo('https://h/r', 'fresh', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }), /boom/);
      assert.equal(fs.existsSync(path.join(root, 'fresh')), false, 'its own reservation is cleaned up');
      const threw = sinon.stub().rejects(new Error('spawn git ENOENT'));
      await assert.rejects(cloneRepo('https://h/r', 'fresh2', { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: threw }), /could not be run/);
      assert.equal(fs.existsSync(path.join(root, 'fresh2')), false);
    });

    it('cloneEnv carries only the allowlist (no server secrets)', () => {
      const env = cloneEnv({ PATH: '/bin', HOME: '/h', MOAG_MASTER_KEY: 'k', ANTHROPIC_API_KEY: 'a', GH_TOKEN: 'g', CI: 'true' }, true);
      assert.equal(env.GIT_ALLOW_PROTOCOL, 'https:ssh');
      for (const k of ['MOAG_MASTER_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'CI']) { assert.equal(k in env, false, k); }
    });
  });

  describe('isGitRepo', () => {
    it('true only for exit 0 + "true"', async () => {
      assert.equal(await isGitRepo('/x', async () => ok('true\n')), true);
      assert.equal(await isGitRepo('/x', async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository', timedOut: false })), false);
      assert.equal(await isGitRepo('/x', async () => { throw new Error('ENOENT'); }), false);
    });

    it('uses -C <dir> with array args', async () => {
      const exec = sinon.stub().resolves(ok('true'));
      await isGitRepo('/some dir; rm -rf /', exec);
      assert.deepEqual(exec.firstCall.args[1], ['-C', '/some dir; rm -rf /', 'rev-parse', '--is-inside-work-tree']);
    });
  });

  describe('gitTopLevel / isPathNested', () => {
    it('returns the realpath of the top level, null on failure or empty output', async () => {
      const ws = path.join(root, 'acme');
      assert.equal(await gitTopLevel(ws, async () => ok(`${ws}\n`)), fs.realpathSync.native(ws));
      assert.equal(await gitTopLevel(ws, async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository', timedOut: false })), null);
      assert.equal(await gitTopLevel(ws, async () => ok('')), null);
      assert.equal(await gitTopLevel(ws, async () => ok(path.join(root, 'missing'))), null);
      assert.equal(await gitTopLevel(ws, async () => { throw new Error('ENOENT'); }), null);
      const exec = sinon.stub().resolves(ok(ws));
      await gitTopLevel('/some dir; x', exec);
      assert.deepEqual(exec.firstCall.args[1], ['-C', '/some dir; x', 'rev-parse', '--show-toplevel']);
    });

    it('isPathNested: strict ancestor or descendant only', () => {
      const a = path.join(root, 'a');
      assert.equal(isPathNested(a, path.join(a, 'b')), true);
      assert.equal(isPathNested(path.join(a, 'b'), a), true);
      assert.equal(isPathNested(a, a), false);
      assert.equal(isPathNested(a, `${a}-b`), false);
      assert.equal(isPathNested(a, path.join(root, 'c')), false);
    });
  });

  describe('planning context', () => {
    it('buildRepoListing runs git ls-files with array args and fsmonitor off, and lists the paths', async () => {
      const exec = sinon.stub().resolves(ok('src/a.ts\0package.json\0'));
      const text = await buildRepoListing('/some dir; rm -rf /', exec);
      assert.deepEqual(exec.firstCall.args[0], 'git');
      assert.deepEqual(exec.firstCall.args[1], ['-c', 'core.fsmonitor=false', '-C', '/some dir; rm -rf /', 'ls-files', '-z']);
      assert.ok(exec.firstCall.args[2].timeoutMs > 0, 'git gets a timeout');
      const lines = text.split('\n');
      assert.match(lines[0], /^Repository files/);
      assert.deepEqual(lines.slice(1), ['src/a.ts', 'package.json']);
    });

    it('buildRepoListing caps the path count and says how many were left out', async () => {
      const paths = Array.from({ length: REPO_LISTING_MAX_PATHS + 7 }, (_, i) => `f${i}.ts`);
      const text = await buildRepoListing('/r', async () => ok(paths.join('\0')));
      const lines = text.split('\n');
      assert.equal(lines.length, 1 + REPO_LISTING_MAX_PATHS + 1);
      assert.equal(lines.at(-1), '… and 7 more file(s) not listed');
      assert.equal(lines.includes(`f${REPO_LISTING_MAX_PATHS}.ts`), false);
    });

    it('buildRepoListing degrades to "unavailable" on a git failure or a spawn error, never throws', async () => {
      const failed = await buildRepoListing('/r', async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository', timedOut: false }));
      assert.match(failed, /\(listing unavailable\)$/);
      const threw = await buildRepoListing('/r', async () => { throw new Error('spawn git ENOENT'); });
      assert.match(threw, /\(listing unavailable\)$/);
    });

    it('detectRepoEngineConfig names the engine config a repo ships', () => {
      const ws = path.join(root, 'acme');
      assert.deepEqual(detectRepoEngineConfig(ws), []);
      fs.mkdirSync(path.join(ws, '.claude'));
      fs.writeFileSync(path.join(ws, '.mcp.json'), '{}');
      assert.deepEqual(detectRepoEngineConfig(ws), ['.claude', '.mcp.json']);
      fs.mkdirSync(path.join(ws, '.gemini'));
      assert.deepEqual(detectRepoEngineConfig(ws), ['.claude', '.mcp.json', '.gemini']);
      assert.deepEqual(detectRepoEngineConfig(path.join(root, 'missing')), []);
    });

    it('detectRepoEngineConfig also names Codex config, agent instruction files, MOAG rules and Cursor rules', () => {
      const ws = path.join(root, 'instr');
      fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });
      for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) { fs.writeFileSync(path.join(ws, f), '# rules'); }
      fs.mkdirSync(path.join(ws, '.moag'));
      fs.writeFileSync(path.join(ws, '.moag', 'rules.json'), '[]');
      fs.mkdirSync(path.join(ws, '.cursor', 'rules'), { recursive: true });
      assert.deepEqual(detectRepoEngineConfig(ws), ['.codex', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.moag/rules.json', '.cursor/rules']);
    });

    it('detectRepoEngineConfig ignores a .moag or .cursor dir without the config inside', () => {
      const ws = path.join(root, 'partial');
      fs.mkdirSync(path.join(ws, '.moag'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.moag', 'plan.json'), '{}');
      fs.mkdirSync(path.join(ws, '.cursor'));
      assert.deepEqual(detectRepoEngineConfig(ws), []);
    });
  });

  describe('ProjectStore + intakeProject', () => {
    const base = { name: 'Acme', stack: 'node-ts' as const, defaultEngine: 'claude' as const };

    it('registers a path project with defaults and persists it', async () => {
      const store = new ProjectStore(dataDir);
      const p = await intakeProject(store, { ...base, source: { kind: 'path', path: 'acme' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: repoRoot });
      assert.match(p.id, /^[A-Za-z0-9-]{1,64}$/);
      assert.equal(p.versionBudgetUsd, 10);
      assert.equal(p.createdBy, 'u1');
      assert.deepEqual(p.source, { kind: 'path' });
      assert.equal(new ProjectStore(dataDir).get(p.id)?.name, 'Acme');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, PROJECTS_FILE), 'utf-8')).schemaVersion, 1);
    });

    it('refuses a folder that is not a git repo', async () => {
      const store = new ProjectStore(dataDir);
      await assert.rejects(intakeProject(store, { ...base, source: { kind: 'path', path: 'acme' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: async () => ({ exitCode: 128, stdout: '', stderr: '', timedOut: false }) }),
      /not a git repository/);
      assert.equal(store.list().length, 0);
    });

    it('refuses registering the same workspace twice', async () => {
      const store = new ProjectStore(dataDir);
      const deps = { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: repoRoot };
      await intakeProject(store, { ...base, source: { kind: 'path', path: 'acme' } }, 'u1', deps);
      await assert.rejects(intakeProject(store, { ...base, source: { kind: 'path', path: './acme/' } }, 'u1', deps), /already belongs/);
      assert.equal(store.list().length, 1);
    });

    it('refuses a workspace nested inside, or containing, a registered one', async () => {
      fs.mkdirSync(path.join(root, 'acme', 'sub'));
      fs.mkdirSync(path.join(root, 'outer', 'inner'), { recursive: true });
      const store = new ProjectStore(dataDir);
      const deps = { projectsRoot: root, allowSsh: false, serverEnv: {}, exec: repoRoot };
      await intakeProject(store, { ...base, source: { kind: 'path', path: 'acme' } }, 'u1', deps);
      await intakeProject(store, { ...base, source: { kind: 'path', path: 'outer/inner' } }, 'u1', deps);
      for (const [rel, why] of [['acme/sub', 'descendant'], ['outer', 'ancestor']]) {
        await assert.rejects(intakeProject(store, { ...base, source: { kind: 'path', path: rel } }, 'u1', deps),
          (e: unknown) => e instanceof ProjectInputError && e.code === 'workspace-nested' && e.status === 409, why);
      }
      // A sibling whose name shares a prefix is not nested.
      fs.mkdirSync(path.join(root, 'acme-two'));
      await intakeProject(store, { ...base, source: { kind: 'path', path: 'acme-two' } }, 'u1', deps);
      assert.equal(store.list().length, 3);
      // The store refuses it too, whoever calls create().
      assert.throws(() => store.create({ ...base, workspacePath: fs.realpathSync.native(path.join(root, 'acme', 'sub')), source: { kind: 'path' }, versionBudgetUsd: 1, createdBy: 'u' }),
        /another project/);
    });

    it('refuses a folder that is inside a repository but not its top level', async () => {
      fs.mkdirSync(path.join(root, 'acme', 'pkg'));
      const store = new ProjectStore(dataDir);
      const top = path.join(root, 'acme');
      const exec: ExecFn = async (_c, args) => ok(args.includes('--show-toplevel') ? `${top.split(path.sep).join('/')}\n` : 'true');
      await assert.rejects(intakeProject(store, { ...base, source: { kind: 'path', path: 'acme/pkg' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }),
      (e: unknown) => e instanceof ProjectInputError && e.code === 'not-repo-root');
      // git's forward-slash top level of the folder itself is accepted.
      const p = await intakeProject(store, { ...base, source: { kind: 'path', path: 'acme' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec });
      assert.equal(p.workspacePath, fs.realpathSync.native(top));
    });

    it('a clone failure leaves no project record and no folder', async () => {
      const store = new ProjectStore(dataDir);
      const exec: ExecFn = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: auth failed', timedOut: false });
      await assert.rejects(intakeProject(store, { ...base, source: { kind: 'clone', url: 'https://h/r.git', dirName: 'cloned' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec }));
      assert.equal(store.list().length, 0);
      assert.equal(fs.existsSync(path.join(dataDir, PROJECTS_FILE)), false);
      assert.equal(fs.existsSync(path.join(root, 'cloned')), false);
    });

    it('a successful clone stores the URL without userinfo', async () => {
      const store = new ProjectStore(dataDir);
      const exec: ExecFn = async (_c, args) => { fs.mkdirSync(args[args.length - 1], { recursive: true }); return ok(); };
      const p = await intakeProject(store, { ...base, source: { kind: 'clone', url: 'https://tok@h/r.git', dirName: 'cl' } }, 'u1',
        { projectsRoot: root, allowSsh: false, serverEnv: {}, exec });
      assert.deepEqual(p.source, { kind: 'clone', url: 'https://h/r.git' });
    });

    it('update changes only mutable settings', () => {
      const store = new ProjectStore(dataDir);
      const p = store.create({ ...base, workspacePath: path.join(root, 'acme'), source: { kind: 'path' }, versionBudgetUsd: 10, createdBy: 'u1' });
      const u = store.update(p.id, { stack: 'go', versionBudgetUsd: 0 });
      assert.equal(u.stack, 'go');
      assert.equal(u.versionBudgetUsd, 0);
      assert.equal(u.workspacePath, p.workspacePath);
      assert.throws(() => store.update('nope', {}), /not found/);
    });
  });

  describe('a new empty project (source kind "new")', () => {
    const base = { name: 'Fresh', stack: 'node-ts' as const, defaultEngine: 'claude' as const };
    /** A git stub that records every call and succeeds, or fails as told. */
    function gitStub(fail: { on?: 'init' | 'commit'; throws?: boolean } = {}) {
      const calls: string[][] = [];
      const exec: ExecFn = async (_c, args) => {
        calls.push(args);
        if (fail.throws) { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); }
        if (fail.on && args.includes(fail.on)) { return { exitCode: 128, stdout: '', stderr: `fatal: ${fail.on} broke`, timedOut: false }; }
        return ok(args.includes('--show-toplevel') ? `${args[args.indexOf('-C') + 1]}\n` : '');
      };
      return { calls, exec };
    }
    const deps = (exec: ExecFn) => ({ projectsRoot: root, allowSsh: false, serverEnv: { PATH: '/bin' }, exec });
    const intakeNew = (store: ProjectStore, rel: string, exec: ExecFn) =>
      intakeProject(store, { ...base, source: { kind: 'new', path: rel } }, 'po-1', deps(exec));
    async function rejectsWith(p: Promise<unknown>, want: string, status?: number): Promise<void> {
      await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof ProjectInputError, String(e));
        assert.equal(e.code, want, e.message);
        if (status !== undefined) { assert.equal(e.status, status); }
        return true;
      });
    }

    it('creates the folder, runs git init and one empty commit as the server identity, then registers it', async () => {
      const store = new ProjectStore(dataDir);
      const git = gitStub();
      const p = await intakeNew(store, 'fresh-app', git.exec);
      const dir = fs.realpathSync.native(path.join(root, 'fresh-app'));
      assert.equal(p.workspacePath, dir);
      assert.deepEqual(p.source, { kind: 'new' });
      assert.equal(new ProjectStore(dataDir).get(p.id)?.createdBy, 'po-1');
      assert.equal(git.calls.length, 3);
      const [init, top, commit] = git.calls;
      assert.ok(init.includes('init') && init.includes('-C') && init[init.indexOf('-C') + 1] === dir, init.join(' '));
      assert.ok(top.includes('--show-toplevel'), 'the repository git made is checked before the first commit');
      assert.ok(commit.includes('--allow-empty'));
      assert.ok(commit.includes(`user.name=${NEW_REPO_IDENTITY.name}`) && commit.includes(`user.email=${NEW_REPO_IDENTITY.email}`));
      assert.ok(commit.includes('commit.gpgsign=false') && commit.includes('core.hooksPath=/dev/null'), 'no hook and no signing key runs');
    });

    it('creates missing parent folders, and an existing EMPTY folder is used as it is', async () => {
      const store = new ProjectStore(dataDir);
      await intakeNew(store, 'clients/acme-web', gitStub().exec);
      assert.ok(fs.statSync(path.join(root, 'clients', 'acme-web')).isDirectory());
      // `acme` exists and is empty (beforeEach).
      const p = await intakeNew(store, 'acme', gitStub().exec);
      assert.equal(p.workspacePath, fs.realpathSync.native(path.join(root, 'acme')));
    });

    it('refuses an existing folder that is not empty, and leaves it as it was', async () => {
      const store = new ProjectStore(dataDir);
      const git = gitStub();
      await rejectsWith(intakeNew(store, 'nested', git.exec), 'dest-not-empty', 409);
      fs.writeFileSync(path.join(root, 'acme', 'README.md'), 'hi\n');
      await rejectsWith(intakeNew(store, 'acme', git.exec), 'dest-not-empty', 409);
      fs.writeFileSync(path.join(root, 'a-file'), 'x');
      await rejectsWith(intakeNew(store, 'a-file', git.exec), 'not-a-directory');
      assert.deepEqual(git.calls, [], 'git never ran');
      assert.deepEqual(fs.readdirSync(path.join(root, 'nested')), ['deep']);
      assert.equal(fs.existsSync(path.join(root, 'acme', '.git')), false);
      assert.equal(store.list().length, 0);
    });

    it('never reaches outside the root: absolute paths, "..", the root itself, and a symlinked parent', async () => {
      const store = new ProjectStore(dataDir);
      const git = gitStub();
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      for (const rel of [outside, path.join(root, 'abs-inside'), '/etc/x', 'C:\\x', '../outside/x', 'a/../../x', '.', './', '']) {
        await rejectsWith(intakeNew(store, rel, git.exec), 'invalid-path');
      }
      let linked = true;
      try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { linked = false; }
      if (linked) {
        await rejectsWith(intakeNew(store, 'link/escaped', git.exec), 'path-escape');
        await rejectsWith(intakeNew(store, 'link', git.exec), 'path-escape');
        assert.deepEqual(fs.readdirSync(outside), [], 'nothing was created outside the root');
      }
      assert.deepEqual(git.calls, []);
      assert.equal(store.list().length, 0);
    });

    it('refuses a folder inside another project\'s workspace before creating anything', async () => {
      const store = new ProjectStore(dataDir);
      await intakeNew(store, 'owner', gitStub().exec);
      const git = gitStub();
      await rejectsWith(intakeNew(store, 'owner/sub', git.exec), 'workspace-nested', 409);
      await rejectsWith(intakeNew(store, 'owner', git.exec), 'workspace-registered', 409);
      assert.equal(fs.existsSync(path.join(root, 'owner', 'sub')), false);
      assert.deepEqual(git.calls, []);
    });

    it('git missing on the server: git-missing, and nothing is left behind', async () => {
      const store = new ProjectStore(dataDir);
      await rejectsWith(intakeNew(store, 'clients/no-git', gitStub({ throws: true }).exec), 'git-missing', 500);
      assert.equal(fs.existsSync(path.join(root, 'clients')), false, 'the parents it created are removed too');
      // In a folder that was already there (empty), only what git made goes.
      await rejectsWith(intakeNew(store, 'acme', gitStub({ throws: true }).exec), 'git-missing');
      assert.ok(fs.existsSync(path.join(root, 'acme')));
      assert.equal(store.list().length, 0);
    });

    it('git failing (init or the first commit): init-failed with git\'s last line, and nothing is left behind', async () => {
      const store = new ProjectStore(dataDir);
      await rejectsWith(intakeNew(store, 'bad-init', gitStub({ on: 'init' }).exec), 'init-failed', 502);
      await rejectsWith(intakeNew(store, 'bad-commit', gitStub({ on: 'commit' }).exec), 'init-failed', 502);
      assert.equal(fs.existsSync(path.join(root, 'bad-init')), false);
      assert.equal(fs.existsSync(path.join(root, 'bad-commit')), false);
      assert.equal(store.list().length, 0);
    });

    /** projects.ts loaded with an fs whose existsSync is counted, and fails past `limit` calls instead of hanging. */
    function withCountedExists(answer: (p: fs.PathLike) => boolean, limit = 10_000) {
      let calls = 0;
      const mod = proxyquire('../../../server/projects', {
        // A copy of every member of the real module (its descriptors, so no deprecated getter is
        // read), with existsSync replaced: the module under test copies own members only.
        fs: Object.defineProperty(Object.defineProperties({}, Object.getOwnPropertyDescriptors(require('fs'))) as typeof fs, 'existsSync', { value: (p: fs.PathLike) => {
          if (++calls > limit) { throw new Error('the ancestor walk did not end'); }
          return answer(p);
        } }),
      }) as typeof import('../../../server/projects');
      return { mod, calls: () => calls };
    }
    /** The error code a sync call throws (from a module copy loaded by proxyquire, so no instanceof). */
    function codeOf(fn: () => unknown): string {
      try { fn(); } catch (e) { return (e as { code?: string }).code ?? String(e); }
      return assert.fail('did not throw');
    }

    it('a folder name with a colon in any segment (a drive letter part-way, or a stream name) is refused promptly', async () => {
      const store = new ProjectStore(dataDir);
      const counted = withCountedExists((p) => fs.existsSync(p));
      for (const rel of ['foo/Q:x', 'foo/C:bar', 'foo:bar', 'a/b/Z:', 'ok\\Q:x']) {
        assert.equal(codeOf(() => counted.mod.planNewRepo(root, rel, store)), 'invalid-path', rel);
        assert.equal(code(() => resolveProjectPath(root, rel, () => false)), 'invalid-path', rel);
        await rejectsWith(intakeNew(store, rel, gitStub().exec), 'invalid-path');
      }
      assert.equal(counted.calls(), 0, 'refused from the text alone, before any walk');
      assert.equal(fs.existsSync(path.join(root, 'foo')), false, 'nothing was created');
      assert.equal(store.list().length, 0);
    });

    it('the ancestor walk stops at a filesystem root that does not exist, and refuses', () => {
      const store = new ProjectStore(dataDir);
      // Nothing on the way "exists", as on a missing drive: the walk must still end.
      const counted = withCountedExists(() => false);
      assert.equal(codeOf(() => counted.mod.planNewRepo(root, 'fresh/app', store)), 'invalid-path');
      assert.ok(counted.calls() < 100, `walked ${counted.calls()} times`);
    });

    it('two concurrent creates for one name: the second waits, is refused, and never touches the first one\'s folder or repository', async () => {
      const store = new ProjectStore(dataDir);
      const order: string[] = [];
      // A: slow git that makes a real .git; B: git that fails (its undo must not reach A's work).
      const slow: ExecFn = async (_c, args) => {
        if (args.includes('--show-toplevel')) { return ok(`${args[args.indexOf('-C') + 1]}\n`); }
        order.push(`A:${args.includes('init') ? 'init' : 'commit'}`);
        await new Promise((r) => setTimeout(r, 30));
        if (args.includes('init')) { fs.mkdirSync(path.join(args[args.indexOf('-C') + 1], '.git')); }
        return ok();
      };
      const failing: ExecFn = async () => { order.push('B:git'); return { exitCode: 128, stdout: '', stderr: 'fatal: no', timedOut: false }; };
      const [a, b] = await Promise.allSettled([intakeNew(store, 'team/a', slow), intakeNew(store, 'team/a', failing)]);
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'rejected');
      const reason = (b as PromiseRejectedResult).reason as unknown;
      assert.ok(reason instanceof ProjectInputError, String(reason));
      assert.equal(reason.status, 409);
      assert.deepEqual(order, ['A:init', 'A:commit'], 'B never ran git');
      assert.ok(fs.existsSync(path.join(root, 'team', 'a', '.git')), 'A\'s repository is intact');
      assert.equal(store.list().length, 1);
    });

    it('an undo removes only what this call created: a parent another request filled in the meantime stays', async () => {
      const store = new ProjectStore(dataDir);
      // git fails after "another request" has put its own folder under the parent this call made.
      const exec: ExecFn = async () => {
        fs.mkdirSync(path.join(root, 'team', 'other'));
        return { exitCode: 128, stdout: '', stderr: 'fatal: broke', timedOut: false };
      };
      await rejectsWith(createEmptyRepo('team/a', store, deps(exec)), 'init-failed', 502);
      assert.equal(fs.existsSync(path.join(root, 'team', 'a')), false, 'the folder it made is gone');
      assert.ok(fs.existsSync(path.join(root, 'team', 'other')), 'the other request\'s folder survives');
    });

    it('an undo in an existing folder removes only the .git its own git init made', async () => {
      const store = new ProjectStore(dataDir);
      // `acme` exists and is empty; git init makes .git, then the first commit fails.
      const exec: ExecFn = async (_c, args) => {
        if (args.includes('init')) { fs.mkdirSync(path.join(root, 'acme', '.git')); return ok(); }
        if (args.includes('--show-toplevel')) { return ok(`${args[args.indexOf('-C') + 1]}\n`); }
        fs.writeFileSync(path.join(root, 'acme', 'kept.txt'), 'someone else wrote this');
        return { exitCode: 128, stdout: '', stderr: 'fatal: broke', timedOut: false };
      };
      await rejectsWith(createEmptyRepo('acme', store, deps(exec)), 'init-failed', 502);
      assert.equal(fs.existsSync(path.join(root, 'acme', '.git')), false);
      assert.ok(fs.existsSync(path.join(root, 'acme', 'kept.txt')), 'the folder itself and what is in it stay');
    });

    /** Names Windows normalises (trailing dot/space, only dots, a device name) and other reserved names. */
    const NORMALISED_NAMES = ['...', '.. ', ' ..', 'team/...', 'a.', 'a ', 'CON', 'nul/x', 'com1.txt', 'LPT9', 'a<b', 'a|b', 'a?', 'a*', 'a"b', 'a\tb', 'team/b.'];
    /** Whether each folder from the root up to the filesystem root has a `.git`. */
    function gitDirsUpward(): string[] {
      const found: string[] = [];
      for (let dir = root; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git'))) { found.push(dir); }
        if (path.dirname(dir) === dir) { return found; }
      }
    }

    it('refuses a name Windows would normalise to another folder (trailing dot or space, only dots, device names, reserved characters)', async () => {
      const store = new ProjectStore(dataDir);
      const before = fs.readdirSync(root).sort();
      const gitBefore = gitDirsUpward();
      const git = gitStub();
      for (const rel of NORMALISED_NAMES) {
        await rejectsWith(intakeNew(store, rel, git.exec), 'invalid-path', 400);
        await rejectsWith(createEmptyRepo(rel, store, deps(git.exec)), 'invalid-path', 400);
        assert.equal(code(() => planNewRepo(root, rel, store)), 'invalid-path', JSON.stringify(rel));
        assert.equal(code(() => resolveProjectPath(root, rel, () => false)), 'invalid-path', JSON.stringify(rel));
      }
      assert.deepEqual(git.calls, [], 'git never ran');
      assert.deepEqual(fs.readdirSync(root).sort(), before, 'nothing was left behind');
      assert.deepEqual(gitDirsUpward(), gitBefore, 'no .git in the root or any parent');
      assert.equal(store.list().length, 0);
    });

    it('still accepts ordinary names with dots and spaces inside them', () => {
      const store = new ProjectStore(dataDir);
      for (const rel of ['my app', 'v1.2', '.hidden', 'a/./b', 'console', 'com10', 'lpt', 'nul-check']) {
        assert.doesNotThrow(() => planNewRepo(root, rel, store), rel);
      }
    });

    it('with real git: the normalised names are refused before git runs, and no .git appears in the root or a parent', async () => {
      const store = new ProjectStore(dataDir);
      const gitBefore = gitDirsUpward();
      for (const rel of ['...', '.. ', ' ..', 'team/...', 'a.', 'a ', 'CON']) {
        await rejectsWith(intakeProject(store, { ...base, source: { kind: 'new', path: rel } }, 'po-1',
          { projectsRoot: root, allowSsh: false, serverEnv: process.env }), 'invalid-path', 400);
      }
      assert.deepEqual(gitDirsUpward(), gitBefore);
      assert.deepEqual(fs.readdirSync(root).sort(), ['acme', 'nested']);
      assert.equal(store.list().length, 0);
    });

    it('defence in depth: a repository git made anywhere but the named folder is refused before the first commit, and the folder is removed', async () => {
      const store = new ProjectStore(dataDir);
      const calls: string[][] = [];
      // git "reports" the projects root as the top level, as a normalised name would make it.
      const exec: ExecFn = async (_c, args) => {
        calls.push(args);
        return ok(args.includes('--show-toplevel') ? `${root}\n` : '');
      };
      await rejectsWith(createEmptyRepo('team/x', store, deps(exec)), 'path-escape', 400);
      assert.equal(calls.some((a) => a.includes('commit')), false, 'no commit was made');
      assert.equal(fs.existsSync(path.join(root, 'team')), false, 'the folders it made are removed');
      // git failing to answer at all is refused the same way.
      const silent: ExecFn = async (_c, args) => (args.includes('--show-toplevel') ? { exitCode: 128, stdout: '', stderr: 'fatal', timedOut: false } : ok());
      await rejectsWith(createEmptyRepo('acme', store, deps(silent)), 'path-escape', 400);
      assert.ok(fs.existsSync(path.join(root, 'acme')), 'an existing empty folder stays');
      assert.equal(store.list().length, 0);
    });

    it('planNewRepo answers what the create would do, creating nothing', () => {
      const store = new ProjectStore(dataDir);
      assert.notEqual(planNewRepo(root, 'brand-new', store).firstNew, null);
      assert.equal(fs.existsSync(path.join(root, 'brand-new')), false);
      assert.equal(planNewRepo(root, 'acme', store).firstNew, null, 'empty and existing');
      assert.equal(code(() => planNewRepo(root, 'nested', store)), 'dest-not-empty');
      assert.equal(code(() => planNewRepo(root, '..', store)), 'invalid-path');
    });

    it('with real git: the repository has an empty first commit by the server identity', async function () {
      const store = new ProjectStore(dataDir);
      let p;
      try {
        p = await intakeProject(store, { ...base, source: { kind: 'new', path: 'real-git' } }, 'po-1',
          { projectsRoot: root, allowSsh: false, serverEnv: process.env });
      } catch (err) {
        if (err instanceof ProjectInputError && err.code === 'git-missing') { this.skip(); }
        if (/EPERM/.test(String(err))) { this.skip(); }
        throw err;
      }
      const log = execFileSync('git', ['-C', p.workspacePath, 'log', '--format=%an <%ae>|%s'], { encoding: 'utf-8' }).trim();
      assert.equal(log, `${NEW_REPO_IDENTITY.name} <${NEW_REPO_IDENTITY.email}>|${NEW_REPO_COMMIT_MESSAGE}`);
      assert.equal(execFileSync('git', ['-C', p.workspacePath, 'ls-files'], { encoding: 'utf-8' }).trim(), '', 'nothing tracked');
    });
  });
});
