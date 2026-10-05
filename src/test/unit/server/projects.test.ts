import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  ProjectStore, ProjectInputError, resolveProjectPath, validateCloneUrl, cloneRepo, isGitRepo, gitTopLevel, isPathNested, intakeProject,
  cloneEnv, redactUrlUserinfo, ExecFn, PROJECTS_FILE, buildRepoListing, detectRepoEngineConfig, REPO_LISTING_MAX_PATHS,
} from '../../../server/projects';
import { ExecFileAsyncResult } from '../../../utils/exec-file';

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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
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
});
