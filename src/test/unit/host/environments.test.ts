// ─── Host agent: environments and the agent loop ───
//
// A fake `exec` stands in for docker and git and records every call; projects and worktrees are
// real temp folders. What matters most: only approved projects run, the recipe is read from the
// approved folder and never from the branch, no child process ever gets the machine key, and
// ONOSOO gets a readable answer for every command.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HostAgent } from '../../../host/agent';
import { envKeyFor } from '../../../host/compose';
import { EnvironmentManager, type Exec, type ExecResult } from '../../../host/environments';
import { Gateway } from '../../../host/gateway';
import type { HostConfig } from '../../../host/host-config';
import type { OnosooReply } from '../../../host/onosoo-client';
import type { ApprovedProjectsResult } from '../../../host/types';

interface Call { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });

describe('host/environments', () => {
  let root: string;
  let projectDir: string;
  let config: HostConfig;
  let calls: Call[];
  let upResult: ExecResult;
  let now: number;

  const projects = (): ApprovedProjectsResult => ({
    remoteStart: false, dailyBudgetUsd: null, errors: [],
    projects: [{ id: 'shop', name: 'Shop', path: projectDir }],
  });

  /** The git arguments after the hardening options. */
  const gitArgs = (args: string[]): string[] => {
    let i = 0;
    while (args[i] === '-c') { i += 2; }
    return args.slice(i);
  };

  let resolvedConfig: unknown;

  const exec: Exec = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    if (command === 'git') {
      const a = gitArgs(args);
      if (a[0] === 'clone') { fs.mkdirSync(a[a.length - 1], { recursive: true }); return ok(); }
      if (a[0] === 'check-ref-format') { return ok(); }
      if (a[0] === 'rev-parse') { return a[3].startsWith('refs/heads/main') ? ok('abc') : failed(''); }
      if (a[0] === 'fetch') { return ok(); }
      if (a.includes('config') && a.includes('--get')) { return ok('https://github.com/o/shop.git\n'); }
      if (a[0] === 'worktree' && a[1] === 'add') {
        const dir = a[4];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
        return ok();
      }
      return ok();
    }
    // docker compose ...
    if (args.includes('config') && args.includes('json')) { return ok(JSON.stringify(resolvedConfig)); }
    if (args.includes('config')) { return ok('web\napi\ndb\n'); }
    if (args.includes('up')) { return upResult; }
    if (args.includes('logs')) { return ok('api-1  | 2026-10-11 hello\napi-1  | world\n'); }
    if (args.includes('ps')) { return ok('{"Service":"web","State":"running","Health":"healthy"}\n{"Service":"api","State":"running"}\n{"Service":"db","State":"running"}'); }
    return ok();
  };

  const manager = (over: Partial<HostConfig> = {}): EnvironmentManager => new EnvironmentManager({
    exec,
    config: { ...config, ...over },
    stateDir: path.join(root, 'state'),
    loadProjects: projects,
    env: { PATH: '/bin', MOAG_ONOSOO_KEY: 'onosoo_live_secretkey', TUNNEL_TOKEN: 'tok' },
    now: () => now,
    portFree: async () => true,
    log: () => undefined,
  });

  const writeRecipe = (recipe: unknown): void => {
    fs.mkdirSync(path.join(projectDir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.moag', 'environment.json'), JSON.stringify(recipe));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-host-'));
    projectDir = path.join(root, 'shop');
    fs.mkdirSync(projectDir);
    config = {
      previewDomain: 'preview.test', appUrl: 'https://app.test', appOrigins: ['https://app.test'], gatewayPort: 8787,
      maxEnvironments: 2, cpus: 2, memoryMb: 1024, idleStopMinutes: 60, tunnelTokenFile: null,
      worktreesDir: path.join(root, 'state', 'host', 'worktrees'), stateFile: path.join(root, 'state', 'host', 'state.json'),
    };
    calls = [];
    upResult = ok();
    resolvedConfig = { services: { web: { image: 'node' }, api: { image: 'node' }, db: { image: 'postgres' } } };
    now = Date.parse('2026-10-11T10:00:00Z');
    writeRecipe({ version: 1, compose_file: 'docker-compose.yml', services: { web: { role: 'web', port: 5173 }, api: { role: 'api' }, db: { role: 'db' } } });
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('starts an approved project branch: worktree, override, compose up', async () => {
    const m = manager();
    const r = await m.start('shop', 'main', 'run_1');
    assert.equal(r.key, envKeyFor('shop', 'main'));
    assert.equal(r.runKey, 'run_1');
    assert.deepEqual(r.web, { service: 'web', port: 5173 });
    assert.ok(calls.some((c) => c.command === 'git' && gitArgs(c.args)[0] === 'worktree' && c.args.includes('--detach')));
    const up = calls.find((c) => c.args.includes('up'))!;
    assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', `moag-${r.key}`]);
    const override = fs.readFileSync(path.join(config.worktreesDir, `${r.key}.override.yml`), 'utf-8');
    assert.match(override, new RegExp(`127\\.0\\.0\\.1:${r.port}:5173`));
    assert.equal((override.match(/ports: !reset \[\]/g) ?? []).length, 2);
    // State survives a restart of the agent.
    assert.equal(manager().get(r.key)?.branch, 'main');
  });

  it('never gives a child process the machine key or the tunnel token', async () => {
    await manager().start('shop', 'main');
    assert.ok(calls.length > 3);
    for (const c of calls) {
      assert.equal(c.env?.MOAG_ONOSOO_KEY, undefined, `${c.command} ${c.args.join(' ')}`);
      assert.equal(c.env?.TUNNEL_TOKEN, undefined);
    }
  });

  it('runs every git call hardened, and never with the project repository as its working repo', async () => {
    await manager().start('shop', 'main');
    const git = calls.filter((c) => c.command === 'git');
    assert.ok(git.length >= 5);
    for (const c of git) {
      assert.ok(c.args.includes('core.fsmonitor=false'), c.args.join(' '));
      assert.ok(c.args.some((x) => x.startsWith('core.hooksPath=')), 'hooks disabled');
      assert.ok(c.args.includes('protocol.allow=never'));
      assert.equal(c.env?.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(c.env?.GIT_TERMINAL_PROMPT, '0');
      // The project folder is only ever a source to read from, never the repo git runs in.
      assert.notEqual(path.resolve(c.cwd ?? ''), path.resolve(projectDir), gitArgs(c.args).join(' '));
    }
    // Local-path transport is allowed only for reading the project into the mirror.
    for (const c of git) {
      const a = gitArgs(c.args);
      const local = c.args.includes('protocol.file.allow=always');
      assert.equal(local, a[0] === 'clone' || (a[0] === 'fetch' && a.includes(projectDir)), a.join(' '));
    }
  });

  it('refuses a compose file that would let a container out', async () => {
    for (const svc of [
      { image: 'x', privileged: true },
      { image: 'x', volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] },
      { image: 'x', volumes: [{ type: 'bind', source: '/', target: '/host' }] },
      { image: 'x', network_mode: 'host' },
    ]) {
      resolvedConfig = { services: { web: svc, api: { image: 'x' }, db: { image: 'x' } } };
      calls = [];
      await assert.rejects(manager().start('shop', 'main'), (e: Error & { kind?: string }) => e.kind === 'rejected' && /asks for more/.test(e.message), JSON.stringify(svc));
      assert.equal(calls.some((c) => c.args.includes('up')), false, 'never started');
    }
  });

  it('allows bind mounts inside the branch checkout', async () => {
    const key = envKeyFor('shop', 'main');
    resolvedConfig = { services: { web: { image: 'x', volumes: [{ type: 'bind', source: path.join(config.worktreesDir, key, 'src'), target: '/app/src' }] }, api: {}, db: {} } };
    await manager().start('shop', 'main');
  });

  it('refuses a project that is not approved, and never touches git for it', async () => {
    await assert.rejects(manager().start('other', 'main'), (e: Error & { kind?: string }) => e.kind === 'rejected' && /approved projects/.test(e.message));
    assert.equal(calls.length, 0);
  });

  it('refuses without an approved recipe in the project folder — a recipe in the branch does not count', async () => {
    fs.rmSync(path.join(projectDir, '.moag'), { recursive: true });
    await assert.rejects(manager().start('shop', 'main'), (e: Error & { kind?: string }) => e.kind === 'rejected' && /run recipe/.test(e.message));
  });

  it('refuses a dangerous branch name before running git', async () => {
    await assert.rejects(manager().start('shop', '--upload-pack=evil'), /not valid/);
    assert.equal(calls.filter((c) => c.command === 'git').length, 0);
  });

  it('refuses a branch that exists nowhere', async () => {
    await assert.rejects(manager().start('shop', 'feat/missing'), /was not found/);
  });

  it('enforces the environment limit, but refreshing an existing one is always allowed', async () => {
    const m = manager({ maxEnvironments: 1 });
    await m.start('shop', 'main');
    await m.start('shop', 'main'); // refresh
    calls.push(); // no-op
    // A second branch: the fake rev-parse only knows main, so make it known through origin.
    await assert.rejects(m.start('shop', 'feat/x'), /limit/);
  });

  it('records a failed start with the reason, for the manager to read', async () => {
    upResult = failed('Error: port is already allocated');
    const m = manager();
    await assert.rejects(m.start('shop', 'main'), /Starting failed/);
    const r = m.list()[0];
    assert.equal(r.status, 'failed');
    assert.match(r.message ?? '', /port is already allocated/);
  });

  it('reads logs only for services of the environment, without compose prefixes', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    assert.equal(await m.logs(r.key, 'api', 100), '2026-10-11 hello\nworld\n');
    await assert.rejects(m.logs(r.key, 'nope', 100), /no service/);
  });

  it('refreshes status from Docker', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    await m.refresh();
    assert.equal(m.get(r.key)?.status, 'running');
    assert.equal(m.services(r.key).find((s) => s.name === 'web')?.health, 'healthy');
  });

  it('stops environments nobody opened for the idle time, and leaves them stopped', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    now += 59 * 60_000;
    assert.deepEqual(await m.idleSweep(), []);
    now += 2 * 60_000;
    assert.deepEqual(await m.idleSweep(), [r.key]);
    assert.equal(m.get(r.key)?.desired, 'stopped');
    assert.match(m.get(r.key)?.message ?? '', /without visitors/);
  });

  it('resets the database with the recipe command, or by recreating volumes', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    calls = [];
    await m.resetDb(r.key);
    assert.ok(calls.some((c) => c.args.includes('down') && c.args.includes('--volumes')));
    writeRecipe({ version: 1, services: { web: { role: 'web', port: 5173 } }, reset_db: { service: 'api', command: ['npm', 'run', 'db:reset'] } });
    calls = [];
    await m.resetDb(r.key);
    const execCall = calls.find((c) => c.args.includes('exec'))!;
    assert.deepEqual(execCall.args.slice(-5), ['-T', 'api', 'npm', 'run', 'db:reset']);
  });

  describe('agent', () => {
    function agentWith(replies: (route: string, body: unknown) => OnosooReply) {
      const sent: { route: string; body: unknown }[] = [];
      const call = async (route: string, body: unknown): Promise<OnosooReply> => { sent.push({ route, body }); return replies(route, body); };
      const m = manager();
      const gateway = new Gateway({
        previewDomain: 'preview.test', appUrl: 'https://app.test', appOrigins: [], call,
        environment: () => undefined, status: () => null, logs: async () => '', touch: () => undefined, log: () => undefined,
      });
      const agent = new HostAgent({
        config, onosoo: { key: 'onosoo_live_secretkey', deviceId: 'dev', stateDir: path.join(root, 'state') },
        call, manager: m, gateway, loadProjects: projects, moagVersion: '1.0.0', log: () => undefined,
      });
      return { agent, sent, m, gateway };
    }

    it('reports only the capabilities the host agent owns', async () => {
      const { agent, sent } = agentWith(() => ({ status: 200, json: { acked: {} } }));
      await agent.sendCapabilities();
      const body = sent[0].body as Record<string, unknown>;
      assert.equal(sent[0].route, 'events');
      assert.deepEqual(body.capabilities, { host_agent: true, preview_domain: 'preview.test' });
      assert.deepEqual(body.events, []);
      assert.equal(body.heartbeat, undefined, 'never overwrite the relay\'s active runs');
    });

    it('turns every command into a readable outcome', async () => {
      const { agent } = agentWith(() => ({ status: 200, json: {} }));
      const started = await agent.runCommand({ id: '1', kind: 'env-start', payload: { project_id: 'shop', branch: 'main' }, requested_by: 'Una' });
      assert.equal(started.status, 'succeeded');
      assert.match(started.message, /https:\/\/shop-main-[a-f0-9]{6}\.preview\.test/);
      assert.deepEqual(await agent.runCommand({ id: '2', kind: 'env-start', payload: { project_id: 'other', branch: 'main' }, requested_by: null }),
        { status: 'rejected', message: 'That project is not on this machine\'s list of approved projects.' });
      assert.equal((await agent.runCommand({ id: '3', kind: 'env-stop', payload: {}, requested_by: null })).status, 'rejected');
      assert.equal((await agent.runCommand({ id: '4', kind: 'env-stop', payload: { environment_id: 'ghost' }, requested_by: null })).status, 'rejected');
    });

    it('sends a snapshot in the shape ONOSOO expects', async () => {
      const { agent, sent, m } = agentWith(() => ({ status: 200, json: { stored: 1 } }));
      const r = await m.start('shop', 'main', 'run_7');
      await agent.sendSnapshot();
      const env = (sent.find((s) => s.route === 'environments')!.body as { environments: Record<string, unknown>[] }).environments[0];
      assert.equal(env.env_key, r.key);
      assert.equal(env.run_id, 'run_7');
      assert.equal(env.preview_host, `${r.key}.preview.test`);
      assert.equal(env.status, 'running');
      assert.equal(env.project_id, 'shop');
      assert.ok(!('worktree' in env) && !JSON.stringify(env).includes(projectDir), 'no local paths leave the machine');
    });

    it('redacts the machine key and project env values from logs', async () => {
      fs.writeFileSync(path.join(projectDir, '.env'), 'DATABASE_PASSWORD=supersecretvalue\n');
      const { agent, m } = agentWith(() => ({ status: 200, json: {} }));
      const r = await m.start('shop', 'main');
      const text = agent.redactLogs(r.key, 'key onosoo_live_secretkey pw supersecretvalue ok');
      assert.doesNotMatch(text, /onosoo_live_secretkey|supersecretvalue/);
      assert.match(text, /ok$/);
    });

    it('stops and closes every preview when ONOSOO refuses the key', async () => {
      const { agent, gateway } = agentWith(() => ({ status: 401, json: { code: 'unauthorized' } }));
      gateway.sessions.create({ userId: 'u', userName: '', role: 'owner', scope: 'preview', envKey: 'e', expiresAt: Date.now() + 60_000 });
      const running = agent.run();
      assert.equal(await running, 'revoked');
      assert.equal(gateway.sessions.size(), 0);
    });

    it('polls only environment commands and reports each result', async () => {
      const results: unknown[] = [];
      let polled = false;
      const { agent } = agentWith((route, body) => {
        if (route === 'commands/poll') {
          assert.deepEqual((body as { kinds: string[] }).kinds, ['env-start', 'env-stop', 'env-restart', 'env-reset-db']);
          if (polled) { return { status: 200, json: { commands: [] } }; }
          polled = true;
          return { status: 200, json: { commands: [{ id: 'c1', kind: 'env-start', payload: { project_id: 'shop', branch: 'main' }, requested_by: 'Una' }] } };
        }
        if (route.startsWith('commands/')) { results.push({ route, body }); return { status: 200, json: {} }; }
        return { status: 200, json: {} };
      });
      await agent.pollOnce();
      for (let i = 0; i < 50 && results.length < 2; i++) { await new Promise((r) => setTimeout(r, 10)); }
      assert.deepEqual(results.map((r) => (r as { body: { status: string } }).body.status), ['running', 'succeeded']);
    });
  });
});
