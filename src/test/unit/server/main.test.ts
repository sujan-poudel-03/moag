import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { bootPreconditionError } from '../../../server/main';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('server main', () => {
  describe('bootPreconditionError (AC3)', () => {
    const users = (roles: string[][]) => ({ list: () => roles.map((r) => ({ roles: r })) }) as never;

    it('refuses to start with zero admins and no bootstrap token', () => {
      assert.match(bootPreconditionError(users([]), { bootstrapToken: null }) ?? '', /MOAG_BOOTSTRAP_TOKEN/);
      assert.match(bootPreconditionError(users([['reviewer']]), { bootstrapToken: null }) ?? '', /No admin/);
    });

    it('starts with a bootstrap token, or once an admin exists', () => {
      assert.equal(bootPreconditionError(users([]), { bootstrapToken: 'x'.repeat(24) }), null);
      assert.equal(bootPreconditionError(users([['admin']]), { bootstrapToken: null }), null);
    });
  });

  describe('spawnRunWorker', () => {
    it('spawns node with array args, no shell, cwd = workspace, the built env and an IPC channel', () => {
      const spawn = sinon.stub().returns({});
      const execSync = sinon.stub();
      const mod = proxyquire('../../../server/main', { child_process: { spawn, execSync } });
      const env = { PATH: '/bin', MOAG_CONFIG_PATH: '/data/c.json' };
      mod.spawnRunWorker({ jobPath: '/data/projects/p/runs/r/job.json', workspace: '/ws/acme', env });
      assert.equal(spawn.calledOnce, true);
      const [cmd, args, opts] = spawn.firstCall.args;
      assert.equal(cmd, process.execPath);
      assert.equal(args.length, 2);
      assert.match(args[0], /run-worker\.js$/);
      assert.equal(args[1], '/data/projects/p/runs/r/job.json');
      assert.equal(opts.shell, false);
      assert.equal(opts.cwd, '/ws/acme');
      assert.equal(opts.env, env);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.detached, true, 'detached on every platform, Windows included, so a server crash cannot kill the worker under its agent');
      assert.equal(execSync.called, false);
    });
  });
});
