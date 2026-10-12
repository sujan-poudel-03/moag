import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  DEPENDENCY_INSTALL_FAILED_MARKER,
  INSTALL_TABLE,
  DependencyInstallSettings,
  DependencyStamp,
  PlanEnvironment,
  PlannedInstall,
  _resetDependencyInstallsForTest,
  describeInstallRule,
  ensureDependencies,
  planDependencyInstalls,
  readDependencyInstallSettings,
  readDependencyStamp,
  writeDependencyStamp,
} from '../../../runner/dependency-install';
import type { GateOptions, GateResult } from '../../../runner/evidence';
import type { DependencyEvent } from '../../../models/types';

// No test in this file spawns anything: planning reads temp-dir files, and every
// install goes through an injected fake `exec`.

const ON: DependencyInstallSettings = { enabled: true, ignoreScripts: false, pythonVenv: null };
const ALL_TOOLS: PlanEnvironment = { platform: 'linux', commandExists: () => true };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-deps-'));
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

/** A .pnp.cjs that registers the packages pkg() declares, as Yarn writes them (quoted names). */
const PNP_MAP = '// pnp\nconst RAW_RUNTIME_STATE = {"packageRegistryData": [["typescript", []]]};\n';
/** A .pnp.cjs from before typescript was declared: it registers another package only. */
const STALE_PNP_MAP = '// pnp\nconst RAW_RUNTIME_STATE = {"packageRegistryData": [["left-pad", []]]};\n';

function pkg(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { typescript: '^5.0.0' }, ...extra }, null, 2);
}

/** A lockfileVersion-3 package-lock.json whose root entry records exactly `root`. */
function npmLock(root: Record<string, unknown> = { devDependencies: { typescript: '^5.0.0' } },
  workspaces: Record<string, Record<string, unknown>> = {}): string {
  return JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', ...root }, ...workspaces } });
}

/** Simulate an installed package: `node_modules/<name>/package.json`. */
function installed(dir: string, ...names: string[]): void {
  for (const name of names) { write(dir, `node_modules/${name}/package.json`, JSON.stringify({ name })); }
}

function plan(dir: string, settings = ON, env = ALL_TOOLS, stamp?: DependencyStamp): PlannedInstall[] {
  return planDependencyInstalls(dir, stamp ?? readDependencyStamp(dir), settings, env);
}

/** Record the current plan as installed, as a successful ensure would. */
function recordInstalled(dir: string, settings = ON): void {
  const stamp = readDependencyStamp(dir);
  for (const item of plan(dir, settings)) {
    stamp.entries[item.key] = {
      ecosystem: item.ecosystem, dir: item.dir, status: 'installed', hash: item.hash, files: item.files,
      command: 'x', note: null, at: new Date(0).toISOString(),
    };
  }
  writeDependencyStamp(dir, stamp);
}

function only(items: PlannedInstall[], ecosystem?: string): PlannedInstall {
  const found = ecosystem ? items.filter((i) => i.ecosystem === ecosystem) : items;
  assert.equal(found.length, 1, `expected exactly one planned item, got ${JSON.stringify(items)}`);
  return found[0];
}

function commandOf(item: PlannedInstall): string | null {
  return item.action.kind === 'run' ? item.action.command : null;
}

describe('dependency-install — planning', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('triggers', () => {
    it('first seen without node_modules runs an install (install-dir-missing)', () => {
      write(dir, 'package.json', pkg());
      const item = only(plan(dir));
      assert.equal(item.action.kind, 'run');
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(item.key, 'node:.');
    });

    it('first seen with every declared package installed adopts, without installing (A2)', () => {
      write(dir, 'package.json', pkg({ dependencies: { '@scope/lib': '1.0.0' }, optionalDependencies: { opt: '1' } }));
      installed(dir, 'typescript', '@scope/lib', 'opt');
      const item = only(plan(dir));
      assert.equal(item.action.kind, 'adopt');
      assert.equal(item.trigger, 'first-seen');
    });

    it('first seen with an EMPTY node_modules installs instead of adopting', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', npmLock());
      fs.mkdirSync(path.join(dir, 'node_modules', '.cache'), { recursive: true });
      const item = only(plan(dir));
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(commandOf(item), 'npm ci --no-audit --no-fund');
    });

    it('first seen with a PARTIAL node_modules installs — the greenfield "tsc is not recognized" case', () => {
      // Agent task 1 ran `npm install express`; agent task 2 added typescript and never installed.
      write(dir, 'package.json', pkg({ dependencies: { express: '^4.18.0' } }));
      write(dir, 'package-lock.json', npmLock({ dependencies: { express: '^4.18.0' } }));
      installed(dir, 'express');
      const item = only(plan(dir));
      assert.equal(item.action.kind, 'run');
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(commandOf(item), 'npm install --no-audit --no-fund', 'the lockfile misses typescript → refresh');
    });

    it('a workspace package dependency counts toward completeness (root or package node_modules)', () => {
      write(dir, 'package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { left: '1', right: '1' } }));
      installed(dir, 'left');
      assert.equal(only(plan(dir)).action.kind, 'run', 'right is missing');
      write(dir, 'packages/a/node_modules/right/package.json', '{}');
      assert.equal(only(plan(dir)).action.kind, 'adopt', 'right is in the package\'s own node_modules');
    });

    it('a recorded install with node_modules present is not re-checked for completeness', () => {
      write(dir, 'package.json', pkg({ optionalDependencies: { fsevents: '2' } }));
      installed(dir, 'typescript');
      recordInstalled(dir);
      assert.equal(only(plan(dir)).action.kind, 'none', 'a platform-skipped optional dep must not reinstall forever');
    });

    it('unchanged with the folder present plans nothing', () => {
      write(dir, 'package.json', pkg());
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      assert.equal(only(plan(dir)).action.kind, 'none');
    });

    it('a dependency change is manifest-changed', () => {
      write(dir, 'package.json', pkg());
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { lodash: '^4.0.0' } }));
      const item = only(plan(dir));
      assert.equal(item.trigger, 'manifest-changed');
      assert.equal(item.action.kind, 'run');
    });

    it('node_modules removed after an install is install-dir-missing', () => {
      write(dir, 'package.json', pkg());
      recordInstalled(dir);
      const item = only(plan(dir));
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(item.action.kind, 'run');
    });

    it('a scripts-only or version-only edit does not trigger (A5)', () => {
      write(dir, 'package.json', pkg());
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ version: '2.0.0', scripts: { build: 'tsc' } }));
      assert.equal(only(plan(dir)).action.kind, 'none');
    });

    it('a reordered dependency map hashes the same', () => {
      write(dir, 'package.json', pkg({ dependencies: { a: '1', b: '2' } }));
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { b: '2', a: '1' } }));
      assert.equal(only(plan(dir)).action.kind, 'none');
    });

    it('an unparseable root package.json declares nothing, so plans nothing', () => {
      write(dir, 'package.json', '{ not json');
      assert.deepEqual(plan(dir), []);
    });

    it('a scripts-only edit to a workspace manifest does not trigger', () => {
      write(dir, 'package.json', pkg({ workspaces: ['packages/*'] }));
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a' }));
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a', scripts: { x: 'y' } }));
      assert.equal(only(plan(dir)).action.kind, 'none', 'scripts-only edit');
    });

    it('a package.json that declares no dependencies plans nothing (no lockfile created)', () => {
      write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node t.js' } }));
      assert.deepEqual(plan(dir), []);
    });

    it('CRLF-only lockfile differences do not trigger', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', '{\n  "lockfileVersion": 3\n}\n');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package-lock.json', '{\r\n  "lockfileVersion": 3\r\n}\r\n');
      assert.equal(only(plan(dir)).action.kind, 'none');
    });

    it('a change to a workspace package manifest is manifest-changed', () => {
      write(dir, 'package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { x: '1' } }));
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      assert.equal(only(plan(dir)).action.kind, 'none');
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { x: '2' } }));
      const item = only(plan(dir));
      assert.equal(item.trigger, 'manifest-changed');
      assert.ok(item.files['packages/a/package.json']);
    });
  });

  describe('npm command choice', () => {
    it('a lockfile in sync with the manifest gives npm ci', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', npmLock());
      const item = only(plan(dir));
      assert.equal(commandOf(item), 'npm ci --no-audit --no-fund');
      assert.equal(item.action.kind === 'run' && item.action.fallback, undefined, 'npm is checked, never retried');
    });

    it('first sight (fresh clone): a dependency added before the first check refreshes with npm install', () => {
      // package.json gained typescript; the lockfile root still lists only express.
      write(dir, 'package.json', pkg({ dependencies: { express: '^4.18.0' } }));
      write(dir, 'package-lock.json', npmLock({ dependencies: { express: '^4.18.0' } }));
      const item = only(plan(dir));
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(commandOf(item), 'npm install --no-audit --no-fund');
    });

    it('first sight: a changed spec, a removed dependency, or a stale workspace entry refreshes', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', npmLock({ devDependencies: { typescript: '^4.0.0' } }));
      assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund', 'spec changed');
      write(dir, 'package-lock.json', npmLock({ devDependencies: { typescript: '^5.0.0', jest: '1' } }));
      assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund', 'dependency removed from package.json');

      write(dir, 'package.json', pkg({ workspaces: ['packages/*'] }));
      write(dir, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { zod: '3' } }));
      write(dir, 'package-lock.json', npmLock(undefined, { 'packages/a': { name: 'a' } }));
      assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund', 'workspace entry is stale');
      write(dir, 'package-lock.json', npmLock(undefined, { 'packages/a': { name: 'a', dependencies: { zod: '3' } } }));
      assert.equal(commandOf(only(plan(dir))), 'npm ci --no-audit --no-fund', 'workspace entry in sync');
    });

    it('first sight: an unparseable, v1, or packages-less lockfile refreshes', () => {
      write(dir, 'package.json', pkg());
      for (const bad of ['{ nope', '{}', JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
        JSON.stringify({ lockfileVersion: 3 })]) {
        write(dir, 'package-lock.json', bad);
        assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund', bad);
      }
    });

    it('no lockfile gives npm install', () => {
      write(dir, 'package.json', pkg());
      assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund');
    });

    it('manifest changed with the lockfile unchanged refreshes with npm install (A1)', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', '{"v":1}');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { lodash: '^4' } }));
      assert.equal(commandOf(only(plan(dir))), 'npm install --no-audit --no-fund');
    });

    it('a changed lockfile gives npm ci', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', '{"v":1}');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { lodash: '^4' } }));
      write(dir, 'package-lock.json', '{"v":2}');
      assert.equal(commandOf(only(plan(dir))), 'npm ci --no-audit --no-fund');
    });

    it('a lockfile that newly appeared gives npm ci', () => {
      write(dir, 'package.json', pkg());
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { lodash: '^4' } }));
      write(dir, 'package-lock.json', '{"v":1}');
      assert.equal(commandOf(only(plan(dir))), 'npm ci --no-audit --no-fund');
    });

    it('npm-shrinkwrap.json counts as an npm lockfile', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'npm-shrinkwrap.json', npmLock());
      assert.equal(commandOf(only(plan(dir))), 'npm ci --no-audit --no-fund');
    });
  });

  describe('pnpm and yarn command choice', () => {
    it('pnpm frozen with a lockfile', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      const item = only(plan(dir));
      assert.equal(item.ecosystem, 'pnpm');
      assert.equal(commandOf(item), 'pnpm install --frozen-lockfile');
    });

    it('first sight: pnpm and yarn frozen commands carry the refresh command as a one-time fallback', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      assert.deepEqual(only(plan(dir)).action,
        { kind: 'run', command: 'pnpm install --frozen-lockfile', fallback: 'pnpm install --no-frozen-lockfile' });
      fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
      write(dir, 'yarn.lock', '# v1\n');
      assert.deepEqual(only(plan(dir)).action,
        { kind: 'run', command: 'yarn install --frozen-lockfile', fallback: 'yarn install' });
      write(dir, '.yarnrc.yml', 'x: 1\n');
      assert.deepEqual(only(plan(dir)).action,
        { kind: 'run', command: 'yarn install --immutable', fallback: 'yarn install' });
    });

    it('a recorded pnpm install with a changed lockfile has no fallback (A1 decides)', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      installed(dir, 'typescript');
      recordInstalled(dir);
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n# changed\n');
      assert.deepEqual(only(plan(dir)).action, { kind: 'run', command: 'pnpm install --frozen-lockfile' });
    });

    it('pnpm refresh when the manifest moved and the lockfile did not', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      recordInstalled(dir);
      write(dir, 'package.json', pkg({ dependencies: { a: '1' } }));
      assert.equal(commandOf(only(plan(dir))), 'pnpm install --no-frozen-lockfile');
    });

    it('pnpm from packageManager without a lockfile', () => {
      write(dir, 'package.json', pkg({ packageManager: 'pnpm@9.1.0' }));
      assert.equal(commandOf(only(plan(dir))), 'pnpm install --no-frozen-lockfile');
    });

    it('yarn classic with yarn.lock', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'yarn.lock', '# yarn lockfile v1\n');
      const item = only(plan(dir));
      assert.equal(item.ecosystem, 'yarn');
      assert.equal(commandOf(item), 'yarn install --frozen-lockfile');
    });

    it('yarn berry from .yarnrc.yml', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'yarn.lock', '__metadata:\n');
      write(dir, '.yarnrc.yml', 'nodeLinker: node-modules\n');
      assert.equal(commandOf(only(plan(dir))), 'yarn install --immutable');
    });

    it('yarn berry from packageManager yarn@4', () => {
      write(dir, 'package.json', pkg({ packageManager: 'yarn@4.1.0' }));
      write(dir, 'yarn.lock', '__metadata:\n');
      assert.equal(commandOf(only(plan(dir))), 'yarn install --immutable');
    });

    describe('yarn berry Plug\'n\'Play (no node_modules, ever)', () => {
      function pnpRepo(rc: string | null = 'nodeLinker: pnp\n'): void {
        write(dir, 'package.json', pkg());
        write(dir, 'yarn.lock', '__metadata:\n');
        if (rc !== null) { write(dir, '.yarnrc.yml', rc); }
      }

      it('a recorded PnP install with .pnp.cjs present and no node_modules is a no-op', () => {
        pnpRepo();
        write(dir, '.pnp.cjs', PNP_MAP);
        recordInstalled(dir);
        assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
        const item = only(plan(dir));
        assert.equal(item.ecosystem, 'yarn');
        assert.equal(item.action.kind, 'none');
      });

      it('nodeLinker absent from .yarnrc.yml means PnP (the Yarn 2+ default)', () => {
        pnpRepo('enableTelemetry: false\r\n');
        write(dir, '.pnp.cjs', PNP_MAP);
        recordInstalled(dir);
        assert.equal(only(plan(dir)).action.kind, 'none');
      });

      it('packageManager yarn@4 without .yarnrc.yml is PnP too', () => {
        write(dir, 'package.json', pkg({ packageManager: 'yarn@4.1.0' }));
        write(dir, 'yarn.lock', '__metadata:\n');
        write(dir, '.pnp.cjs', PNP_MAP);
        recordInstalled(dir);
        assert.equal(only(plan(dir)).action.kind, 'none');
      });

      it('first sight with .pnp.cjs present adopts without installing', () => {
        pnpRepo('nodeLinker: "pnp"  # quoted, with a comment\n');
        write(dir, '.pnp.cjs', PNP_MAP);
        const item = only(plan(dir));
        assert.equal(item.action.kind, 'adopt');
        assert.equal(item.trigger, 'first-seen');
      });

      it('first sight with an old .pnp.cjs that lacks a newly declared package installs instead of adopting', () => {
        pnpRepo();
        write(dir, '.pnp.cjs', STALE_PNP_MAP);
        const item = only(plan(dir));
        assert.notEqual(item.action.kind, 'adopt', 'typescript was added to package.json but no install has resolved it');
        assert.equal(commandOf(item), 'yarn install --immutable');
      });

      it('first sight without .pnp.cjs installs (install-dir-missing)', () => {
        pnpRepo();
        const item = only(plan(dir));
        assert.equal(item.trigger, 'install-dir-missing');
        assert.equal(commandOf(item), 'yarn install --immutable');
      });

      it('a recorded PnP install whose .pnp.cjs was deleted reinstalls', () => {
        pnpRepo();
        write(dir, '.pnp.cjs', PNP_MAP);
        recordInstalled(dir);
        fs.rmSync(path.join(dir, '.pnp.cjs'));
        const item = only(plan(dir));
        assert.equal(item.trigger, 'install-dir-missing');
        assert.equal(commandOf(item), 'yarn install --immutable');
      });

      it('nodeLinker: node-modules still requires node_modules', () => {
        pnpRepo('nodeLinker: node-modules\n');
        write(dir, '.pnp.cjs', '// stale\n');
        recordInstalled(dir);
        const item = only(plan(dir));
        assert.equal(item.trigger, 'install-dir-missing');
        assert.equal(item.action.kind, 'run');
      });

      it('yarn classic ignores .pnp.cjs and still requires node_modules', () => {
        write(dir, 'package.json', pkg());
        write(dir, 'yarn.lock', '# yarn lockfile v1\n');
        write(dir, '.pnp.cjs', PNP_MAP);
        recordInstalled(dir);
        assert.equal(only(plan(dir)).trigger, 'install-dir-missing');
      });
    });

    it('yarn classic from packageManager yarn@1 stays classic', () => {
      write(dir, 'package.json', pkg({ packageManager: 'yarn@1.22.19' }));
      write(dir, 'yarn.lock', '# v1\n');
      assert.equal(commandOf(only(plan(dir))), 'yarn install --frozen-lockfile');
    });

    it('lockfile precedence: pnpm-lock.yaml beats yarn.lock beats package-lock.json', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', '{}');
      write(dir, 'yarn.lock', '# v1\n');
      assert.equal(only(plan(dir)).ecosystem, 'yarn');
      write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      assert.equal(only(plan(dir)).ecosystem, 'pnpm');
    });
  });

  describe('ignoreScripts', () => {
    const IGNORE: DependencyInstallSettings = { ...ON, ignoreScripts: true };
    it('npm gets --ignore-scripts', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'package-lock.json', npmLock());
      assert.equal(commandOf(only(plan(dir, IGNORE))), 'npm ci --no-audit --no-fund --ignore-scripts');
    });
    it('pnpm gets --ignore-scripts', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'pnpm-lock.yaml', 'x\n');
      assert.equal(commandOf(only(plan(dir, IGNORE))), 'pnpm install --frozen-lockfile --ignore-scripts');
    });
    it('yarn classic gets --ignore-scripts', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'yarn.lock', 'x\n');
      assert.equal(commandOf(only(plan(dir, IGNORE))), 'yarn install --frozen-lockfile --ignore-scripts');
    });
    it('yarn berry gets --mode=skip-build', () => {
      write(dir, 'package.json', pkg());
      write(dir, 'yarn.lock', 'x\n');
      write(dir, '.yarnrc.yml', 'x: 1\n');
      assert.equal(commandOf(only(plan(dir, IGNORE))), 'yarn install --immutable --mode=skip-build');
    });
  });

  describe('python', () => {
    it('installs into .venv on posix', () => {
      write(dir, 'requirements.txt', 'requests\n');
      write(dir, '.venv/bin/python', '');
      assert.equal(commandOf(only(plan(dir))), '.venv/bin/python -m pip install -r requirements.txt');
    });

    it('installs into venv\\Scripts\\python.exe on win32', () => {
      write(dir, 'requirements.txt', 'requests\n');
      write(dir, 'venv/Scripts/python.exe', '');
      const item = only(plan(dir, ON, { platform: 'win32', commandExists: () => true }));
      assert.equal(commandOf(item), 'venv\\Scripts\\python.exe -m pip install -r requirements.txt');
    });

    it('uses a configured venv inside the workspace', () => {
      write(dir, 'requirements.txt', 'requests\n');
      write(dir, 'envs/py/bin/python', '');
      write(dir, '.venv/bin/python', '');
      const item = only(plan(dir, { ...ON, pythonVenv: 'envs/py' }));
      assert.equal(commandOf(item), 'envs/py/bin/python -m pip install -r requirements.txt');
    });

    it('rejects a configured venv with shell metacharacters or .. and falls back to detection', () => {
      write(dir, 'requirements.txt', 'requests\n');
      write(dir, '.venv/bin/python', '');
      for (const bad of ['envs&calc', '../outside', '/abs/venv', 'a b']) {
        const item = only(plan(dir, { ...ON, pythonVenv: bad }));
        assert.equal(commandOf(item), '.venv/bin/python -m pip install -r requirements.txt', bad);
      }
    });

    it('no virtualenv gives the note, never the system interpreter', () => {
      write(dir, 'requirements.txt', 'requests\n');
      const item = only(plan(dir));
      assert.deepEqual(item.action, { kind: 'note', note: 'not installed: no virtualenv' });
    });

    it('pyproject.toml alone gives the note', () => {
      write(dir, 'pyproject.toml', '[project]\nname = "x"\n');
      assert.deepEqual(only(plan(dir)).action,
        { kind: 'note', note: 'pyproject.toml has no supported install command (requirements.txt only)' });
    });

    it('the note is not repeated while the hash is unchanged', () => {
      write(dir, 'requirements.txt', 'requests\n');
      const stamp = readDependencyStamp(dir);
      const item = only(plan(dir));
      stamp.entries[item.key] = {
        ecosystem: 'python', dir: '.', status: 'not-installed', hash: item.hash, files: item.files,
        command: null, note: 'n', at: '',
      };
      assert.equal(only(plan(dir, ON, ALL_TOOLS, stamp)).action.kind, 'none');
    });
  });

  describe('other ecosystems', () => {
    it('go runs go mod download', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'go.sum', '');
      const item = only(plan(dir));
      assert.equal(item.ecosystem, 'go');
      assert.equal(commandOf(item), 'go mod download');
      assert.deepEqual(Object.keys(item.files).sort(), ['go.mod', 'go.sum']);
    });

    it('dotnet restores when obj/ is missing and adopts when present', () => {
      write(dir, 'App.csproj', '<Project/>');
      assert.equal(commandOf(only(plan(dir))), 'dotnet restore');
      fs.mkdirSync(path.join(dir, 'obj'));
      assert.equal(only(plan(dir)).action.kind, 'adopt');
      recordInstalled(dir);
      fs.rmSync(path.join(dir, 'obj'), { recursive: true });
      const item = only(plan(dir));
      assert.equal(item.trigger, 'install-dir-missing');
      assert.equal(commandOf(item), 'dotnet restore');
    });

    it('maven, gradle and cargo are notes — their build resolves dependencies', () => {
      write(dir, 'pom.xml', '<project/>');
      write(dir, 'Cargo.toml', '[package]\n');
      const items = plan(dir);
      assert.deepEqual(items.map((i) => [i.ecosystem, i.action.kind]), [['maven', 'note'], ['cargo', 'note']]);
      fs.rmSync(path.join(dir, 'pom.xml'));
      write(dir, 'build.gradle.kts', '');
      assert.equal(only(plan(dir), 'gradle').action.kind, 'note');
    });

    it('a missing toolchain gives a note (A4)', () => {
      write(dir, 'go.mod', 'module x\n');
      const item = only(plan(dir, ON, { platform: 'linux', commandExists: (c) => c !== 'go' }));
      assert.deepEqual(item.action, { kind: 'note', note: 'not installed: go is not on PATH' });
    });

    it('orders families node, python, go, dotnet, jvm, cargo', () => {
      write(dir, 'Cargo.toml', '');
      write(dir, 'pom.xml', '');
      write(dir, 'App.csproj', '');
      write(dir, 'go.mod', '');
      write(dir, 'requirements.txt', '');
      write(dir, 'package.json', pkg());
      assert.deepEqual(plan(dir).map((i) => i.key), ['node:.', 'python:.', 'go:.', 'dotnet:.', 'jvm:.', 'cargo:.']);
    });
  });

  describe('record file', () => {
    it('malformed JSON reads as empty', () => {
      write(dir, '.moag/dependencies.json', '{ nope');
      assert.deepEqual(readDependencyStamp(dir), { version: 1, entries: {} });
      write(dir, '.moag/dependencies.json', JSON.stringify({ version: 2, entries: {} }));
      assert.deepEqual(readDependencyStamp(dir), { version: 1, entries: {} });
      write(dir, '.moag/dependencies.json', JSON.stringify({ version: 1, entries: { 'node:.': { ecosystem: 'bogus' } } }));
      assert.deepEqual(readDependencyStamp(dir), { version: 1, entries: {} });
    });

    it('a missing file reads as empty', () => {
      assert.deepEqual(readDependencyStamp(dir), { version: 1, entries: {} });
    });

    it('round-trips', () => {
      const stamp: DependencyStamp = {
        version: 1,
        entries: {
          'node:.': {
            ecosystem: 'npm', dir: '.', status: 'installed', hash: 'h', files: { 'package.json': 'a' },
            command: 'npm ci --no-audit --no-fund', note: null, at: '2026-10-07T12:00:00.000Z',
          },
        },
      };
      assert.equal(writeDependencyStamp(dir, stamp), true);
      assert.deepEqual(readDependencyStamp(dir), stamp);
    });
  });
});

describe('dependency-install — settings and rule text', () => {
  const cfg = (values: Record<string, unknown>) => ({
    get: <T>(key: string, fallback?: T): T => (key in values ? values[key] : fallback) as T,
  });

  it('defaults: enabled, scripts run, auto-detect venv', () => {
    assert.deepEqual(readDependencyInstallSettings(cfg({})), { enabled: true, ignoreScripts: false, pythonVenv: null });
  });

  it('reads all three keys', () => {
    assert.deepEqual(readDependencyInstallSettings(cfg({
      autoInstallDependencies: false, 'dependencyInstall.ignoreScripts': true, 'dependencyInstall.pythonVenv': ' env ',
    })), { enabled: false, ignoreScripts: true, pythonVenv: 'env' });
  });

  it('enabled rule text names the table and says scripts run', () => {
    const rule = describeInstallRule({ enabled: true, ignoreScripts: false });
    assert.equal(rule.enabled, true);
    assert.ok(rule.text.startsWith('Dependencies are installed automatically with npm ci --no-audit --no-fund, '));
    assert.ok(rule.text.includes('when a dependency manifest or lockfile changes, or when the install output (node_modules, or .pnp.cjs for Yarn Plug\'n\'Play) is missing or lacks a declared package.'));
    assert.ok(rule.text.endsWith('Lifecycle scripts run.'));
    assert.ok(rule.commands.includes('go mod download'));
    assert.ok(rule.commands.includes('dotnet restore'));
  });

  it('ignoreScripts rule text says scripts are skipped and shows the flags', () => {
    const rule = describeInstallRule({ enabled: true, ignoreScripts: true });
    assert.ok(rule.text.endsWith('Lifecycle scripts are skipped (--ignore-scripts).'));
    assert.ok(rule.commands.includes('npm ci --no-audit --no-fund --ignore-scripts'));
    assert.ok(rule.commands.includes('yarn install --immutable --mode=skip-build'));
  });

  it('disabled rule text', () => {
    const rule = describeInstallRule({ enabled: false, ignoreScripts: false });
    assert.deepEqual(rule, {
      enabled: false,
      text: 'Dependencies are not installed automatically on this server; a command that needs them fails unless the plan installs them.',
      commands: [],
    });
  });

  it('the table is frozen', () => {
    assert.ok(Object.isFrozen(INSTALL_TABLE));
    assert.ok(Object.isFrozen(INSTALL_TABLE.npm));
    assert.equal(DEPENDENCY_INSTALL_FAILED_MARKER, '[Dependencies] Install failed');
  });
});

// ─── ensureDependencies ───

interface FakeExec {
  calls: { command: string; options: GateOptions }[];
  exec: (command: string, options: GateOptions) => Promise<GateResult>;
}

function fakeExec(behaviour: (command: string, options: GateOptions) => Promise<Partial<GateResult>> | Partial<GateResult>,
  onCall?: (dir: string) => void): FakeExec {
  const calls: FakeExec['calls'] = [];
  return {
    calls,
    exec: async (command, options) => {
      calls.push({ command, options });
      onCall?.(options.cwd);
      const r = await behaviour(command, options);
      return { command, exitCode: 0, passed: true, output: '', durationMs: 5, timedOut: false, ...r } as GateResult;
    },
  };
}

describe('dependency-install — ensureDependencies', () => {
  let dir: string;
  let events: DependencyEvent[];
  const yes = async (): Promise<boolean> => true;

  beforeEach(() => {
    dir = tmp();
    events = [];
    _resetDependencyInstallsForTest();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const opts = (extra: Partial<Parameters<typeof ensureDependencies>[1]> = {}) => ({
    settings: ON,
    signal: new AbortController().signal,
    timeoutMs: 1000,
    stage: 'task' as const,
    taskId: 't1',
    onEvent: (ev: DependencyEvent) => { events.push(ev); },
    commandExists: yes,
    ...extra,
  });

  it('success writes the record, emits installed, and a second call is a no-op', async () => {
    write(dir, 'package.json', pkg());
    const fake = fakeExec(() => ({ output: 'added 1 package' }), (cwd) => {
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      // The install writes a lockfile — the record must capture it.
      write(cwd, 'package-lock.json', '{"lockfileVersion":3}');
    });
    const first = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(first.ok, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].command, 'npm install --no-audit --no-fund');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'dependencies-installed');
    assert.equal(events[0].stage, 'task');
    assert.equal(events[0].taskId, 't1');
    assert.equal(events[0].command, 'npm install --no-audit --no-fund');
    assert.equal(events[0].exitCode, 0);
    assert.equal(events[0].tail, 'added 1 package');
    const entry = readDependencyStamp(dir).entries['node:.'];
    assert.equal(entry.status, 'installed');
    assert.ok(entry.files['package-lock.json'], 'the lockfile the install wrote is recorded');

    const second = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(second.ok, true);
    assert.equal(fake.calls.length, 1, 'unchanged → no second install');
    assert.equal(events.length, 1);
  });

  it('yarn berry PnP: one install, then consecutive calls are no-ops (no node_modules ever appears)', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'yarn.lock', '__metadata:\n');
    write(dir, '.yarnrc.yml', 'nodeLinker: pnp\n');
    const fake = fakeExec(() => ({ output: 'Done' }), (cwd) => { write(cwd, '.pnp.cjs', PNP_MAP); });
    for (let i = 0; i < 3; i++) {
      const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
      assert.equal(result.ok, true);
    }
    assert.equal(fake.calls.length, 1, 'PnP writes .pnp.cjs, not node_modules — no reinstall on every step');
    assert.equal(fake.calls[0].command, 'yarn install --immutable');
    assert.deepEqual(events.map((e) => e.event), ['dependencies-installed']);
    assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  });

  it('failure: no record, a failed event, ok false, later families not run', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'go.mod', 'module x\n');
    const fake = fakeExec(() => ({ exitCode: 1, passed: false, output: 'x'.repeat(5000) + 'ERESOLVE' }));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, false);
    assert.equal(result.aborted, false);
    assert.equal(fake.calls.length, 1, 'go mod download is not attempted after npm failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'dependencies-install-failed');
    assert.equal(result.failed?.exitCode, 1);
    assert.equal(result.failed?.tail.length, 2000);
    assert.ok(result.failed?.tail.endsWith('ERESOLVE'));
    assert.deepEqual(readDependencyStamp(dir).entries, {});
  });

  it('a timeout (124) is a failure with timedOut true', async () => {
    write(dir, 'package.json', pkg());
    const fake = fakeExec(() => ({ exitCode: 124, passed: false, timedOut: true, output: '[Gate timed out]' }));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, false);
    assert.equal(result.failed?.timedOut, true);
    assert.equal(result.failed?.exitCode, 124);
    assert.deepEqual(readDependencyStamp(dir).entries, {});
  });

  it('an exec that throws is a failure, never a rejection', async () => {
    write(dir, 'package.json', pkg());
    const result = await ensureDependencies(dir, opts({ exec: async () => { throw new Error('spawn EBADF'); } }));
    assert.equal(result.ok, false);
    assert.equal(result.failed?.event, 'dependencies-install-failed');
    assert.ok(result.failed?.tail.includes('spawn EBADF'));
  });

  it('abort during exec: aborted, no event, no record', async () => {
    write(dir, 'package.json', pkg());
    const controller = new AbortController();
    const fake = fakeExec(() => { controller.abort(); return { exitCode: 130, passed: false, output: '[Gate aborted]' }; });
    const result = await ensureDependencies(dir, opts({ exec: fake.exec, signal: controller.signal }));
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.equal(events.length, 0);
    assert.deepEqual(readDependencyStamp(dir).entries, {});
    assert.equal(fs.existsSync(path.join(dir, '.moag', 'dependencies.json')), false);
  });

  it('an already-aborted signal never calls exec', async () => {
    write(dir, 'package.json', pkg());
    const controller = new AbortController();
    controller.abort();
    const fake = fakeExec(() => ({}));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec, signal: controller.signal }));
    assert.equal(result.aborted, true);
    assert.equal(fake.calls.length, 0);
  });

  it('disabled settings never call exec and leave the record untouched', async () => {
    write(dir, 'package.json', pkg());
    const fake = fakeExec(() => ({}));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec, settings: { ...ON, enabled: false } }));
    assert.deepEqual(result, { ok: true, aborted: false, failed: null, events: [] });
    assert.equal(fake.calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, '.moag')), false);
  });

  it('two concurrent calls on one cwd run exec exactly once', async () => {
    write(dir, 'package.json', pkg());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = fakeExec(async () => { await gate; return {}; },
      (cwd) => { fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true }); });
    const a = ensureDependencies(dir, opts({ exec: fake.exec }));
    const b = ensureDependencies(dir, opts({ exec: fake.exec }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(fake.calls.length, 1);
  });

  it("a waiter's own abort releases it and removes its listener", async () => {
    write(dir, 'package.json', pkg());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = fakeExec(async () => { await gate; return {}; });
    const first = ensureDependencies(dir, opts({ exec: fake.exec }));
    await new Promise((r) => setTimeout(r, 10));

    const waiter = new AbortController();
    const add = sinon.spy(waiter.signal, 'addEventListener');
    const remove = sinon.spy(waiter.signal, 'removeEventListener');
    const second = ensureDependencies(dir, opts({ exec: fake.exec, signal: waiter.signal }));
    await new Promise((r) => setTimeout(r, 10));
    waiter.abort();
    const r2 = await second;
    assert.equal(r2.aborted, true);
    assert.ok(add.called);
    assert.equal(remove.callCount, add.callCount, 'every listener added is removed');
    release();
    await first;
    assert.equal(fake.calls.length, 1);
  });

  it('env and processGroup reach exec, with cwd and timeout', async () => {
    write(dir, 'package.json', pkg());
    const fake = fakeExec(() => ({}));
    await ensureDependencies(dir, opts({ exec: fake.exec, env: { PATH: '/bin' }, timeoutMs: 4321 }));
    assert.equal(fake.calls.length, 1);
    const o = fake.calls[0].options;
    assert.deepEqual(o.env, { PATH: '/bin' });
    assert.equal(o.processGroup, true);
    assert.equal(o.cwd, dir);
    assert.equal(o.timeoutMs, 4321);
  });

  it('a note emits not-installed once per hash and writes the record', async () => {
    write(dir, 'requirements.txt', 'requests\n');
    const fake = fakeExec(() => ({}));
    const r1 = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(r1.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'dependencies-not-installed');
    assert.equal(events[0].command, null);
    assert.equal(events[0].note, 'not installed: no virtualenv');
    await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(events.length, 1, 'not repeated while unchanged');
    write(dir, 'requirements.txt', 'requests\nflask\n');
    await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(events.length, 2, 'repeated after the hash changes');
    assert.equal(fake.calls.length, 0);
  });

  it('a missing toolchain is a note from the injected commandExists', async () => {
    write(dir, 'go.mod', 'module x\n');
    const fake = fakeExec(() => ({}));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec, commandExists: async () => false }));
    assert.equal(result.ok, true);
    assert.equal(fake.calls.length, 0);
    assert.equal(events[0].note, 'not installed: go is not on PATH');
    assert.equal(events[0].ecosystem, 'go');
  });

  it('adoption writes the record without running anything', async () => {
    write(dir, 'package.json', pkg());
    installed(dir, 'typescript');
    const fake = fakeExec(() => ({}));
    await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(fake.calls.length, 0);
    assert.equal(events.length, 0);
    assert.equal(readDependencyStamp(dir).entries['node:.'].status, 'adopted');
  });

  it('a partial node_modules on first sight installs (QA: greenfield multi-task) and records installed', async () => {
    write(dir, 'package.json', pkg({ dependencies: { express: '^4.18.0' } }));
    installed(dir, 'express');
    const fake = fakeExec(() => ({}), (cwd) => installed(cwd, 'typescript'));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, true);
    assert.deepEqual(fake.calls.map((c) => c.command), ['npm install --no-audit --no-fund']);
    assert.equal(events[0].event, 'dependencies-installed');
    assert.equal(events[0].trigger, 'install-dir-missing');
    assert.equal(readDependencyStamp(dir).entries['node:.'].status, 'installed');
  });

  it('first sight, stale npm lockfile (fresh clone + agent-added dep) runs npm install, not npm ci', async () => {
    write(dir, 'package.json', pkg({ dependencies: { express: '^4.18.0', zod: '^3.0.0' } }));
    write(dir, 'package-lock.json', npmLock({ dependencies: { express: '^4.18.0' }, devDependencies: { typescript: '^5.0.0' } }));
    const fake = fakeExec(() => ({}));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, true);
    assert.deepEqual(fake.calls.map((c) => c.command), ['npm install --no-audit --no-fund']);
  });

  it('pnpm first sight: frozen fails, the refresh retry succeeds — one installed event with the retry command', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const fake = fakeExec((command) => (command.includes('--frozen-lockfile')
      ? { exitCode: 1, passed: false, output: 'ERR_PNPM_OUTDATED_LOCKFILE', durationMs: 7 }
      : { output: 'Done', durationMs: 11 }));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, true);
    assert.deepEqual(fake.calls.map((c) => c.command), ['pnpm install --frozen-lockfile', 'pnpm install --no-frozen-lockfile']);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'dependencies-installed');
    assert.equal(events[0].command, 'pnpm install --no-frozen-lockfile');
    assert.equal(events[0].durationMs, 18);
    assert.equal(readDependencyStamp(dir).entries['node:.'].command, 'pnpm install --no-frozen-lockfile');
  });

  it('yarn first sight: both frozen and refresh fail — one failed event naming the refresh command', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'yarn.lock', '# v1\n');
    const fake = fakeExec(() => ({ exitCode: 1, passed: false, output: 'network down' }));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 2);
    assert.equal(events.length, 1);
    assert.equal(result.failed?.command, 'yarn install');
    assert.deepEqual(readDependencyStamp(dir).entries, {});
  });

  it('a timed-out frozen install is not retried', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const fake = fakeExec(() => ({ exitCode: 124, passed: false, timedOut: true }));
    const result = await ensureDependencies(dir, opts({ exec: fake.exec }));
    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 1);
    assert.equal(result.failed?.timedOut, true);
  });

  it('an abort during the frozen attempt does not retry', async () => {
    write(dir, 'package.json', pkg());
    write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const controller = new AbortController();
    const fake = fakeExec(() => { controller.abort(); return { exitCode: 130, passed: false }; });
    const result = await ensureDependencies(dir, opts({ exec: fake.exec, signal: controller.signal }));
    assert.equal(result.aborted, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(events.length, 0);
  });
});
