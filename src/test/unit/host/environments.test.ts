// ─── Host agent: environments and the agent loop ───
//
// A fake `exec` stands in for docker and git and records every call; projects and worktrees are
// real temp folders. What matters most: only approved projects run; the recipe comes from the
// approved folder, never the branch; every `up` runs from a configuration that was resolved and
// checked just before, from a host-owned file; git never discovers a repository from a checkout;
// and no child process gets anything from the environment beyond the allow-list.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HostAgent } from '../../../host/agent';
import { envKeyFor } from '../../../host/compose';
import { EnvironmentManager, MAX_RECORDS, type Exec, type ExecResult } from '../../../host/environments';
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
  /** Changes a test applies to the configuration `docker compose config` returns. */
  let mutate: (c: { services: Record<string, Record<string, unknown>> }) => void;
  let branches: Set<string>;

  const projects = (): ApprovedProjectsResult => ({
    remoteStart: false, dailyBudgetUsd: null, errors: [],
    projects: [{ id: 'shop', name: 'Shop', path: projectDir }],
  });

  /** The git arguments after the hardening options and the explicit repository options. */
  const gitArgs = (args: string[]): string[] => {
    let i = 0;
    while (args[i] === '-c') { i += 2; }
    while (args[i] === '--git-dir' || args[i] === '--work-tree') { i += 2; }
    return args.slice(i);
  };
  const argAfter = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  /** What `docker compose config --format json` would print for the current override. */
  const resolve = (args: string[]): string => {
    const override = fs.readFileSync(args[args.indexOf('-f', args.indexOf('-f') + 1) + 1], 'utf-8');
    const m = /127\.0\.0\.1:(\d+):(\d+)/.exec(override);
    const c = {
      name: argAfter(args, '-p'),
      services: {
        web: { image: 'node', ports: m ? [{ mode: 'ingress', host_ip: '127.0.0.1', published: m[1], target: Number(m[2]), protocol: 'tcp' }] : [] },
        api: { image: 'node' },
        db: { image: 'postgres' },
      } as Record<string, Record<string, unknown>>,
    };
    mutate(c);
    return JSON.stringify(c);
  };

  const exec: Exec = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    if (command === 'git') {
      const a = gitArgs(args);
      if (a[0] === '--version') { return ok('git version 2.47.0'); }
      if (a[0] === 'clone') { fs.mkdirSync(a[a.length - 1], { recursive: true }); return ok(); }
      if (a[0] === 'check-ref-format') { return ok(); }
      if (a[0] === 'rev-parse') { return branches.has(a[3].replace(/^refs\/heads\//, '').replace(/\^\{commit\}$/, '')) ? ok('abc') : failed(''); }
      if (a[0] === 'fetch' || a[0] === 'checkout' || (a[0] === 'worktree' && a[1] === 'prune')) { return ok(); }
      if (a[0] === 'worktree' && a[1] === 'add') {
        const dir = a[4];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: (host-owned)\n');
        fs.mkdirSync(path.join(argAfter(args, '--git-dir')!, 'worktrees', path.basename(dir)), { recursive: true });
        return ok();
      }
      return ok();
    }
    // docker compose ...
    if (args.includes('version')) { return ok('2.29.1'); }
    if (args.includes('config') && args.includes('json')) { return ok(resolve(args)); }
    if (args.includes('config')) { return ok('web\napi\ndb\n'); }
    if (args.includes('up')) { return upResult; }
    if (args.includes('logs')) { return ok('api-1  | 2026-10-11 hello\napi-1  | world\n'); }
    if (args.includes('ps')) { return ok('{"Service":"web","State":"running","Health":"healthy"}\n{"Service":"api","State":"running"}\n{"Service":"db","State":"running"}'); }
    return ok();
  };

  const stateDir = (): string => path.join(root, 'state');

  const manager = (over: Partial<HostConfig> = {}, extra: Partial<ConstructorParameters<typeof EnvironmentManager>[0]> = {}): EnvironmentManager => new EnvironmentManager({
    exec,
    config: { ...config, ...over },
    stateDir: stateDir(),
    loadProjects: projects,
    env: {
      PATH: '/bin', HOME: '/home/me', MOAG_ONOSOO_KEY: 'onosoo_live_secretkey', TUNNEL_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_secret', SSH_AUTH_SOCK: '/tmp/agent.sock',
    },
    now: () => now,
    portFree: async () => true,
    log: () => undefined,
    ...extra,
  });

  const writeRecipe = (recipe: unknown): void => {
    fs.mkdirSync(path.join(projectDir, '.moag'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.moag', 'environment.json'), JSON.stringify(recipe));
  };

  const ups = (): Call[] => calls.filter((c) => c.command === 'docker' && c.args.includes('up'));

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
    mutate = () => undefined;
    branches = new Set(['main', 'feat/a', 'feat/b', 'feat/c']);
    now = Date.parse('2026-10-11T10:00:00Z');
    writeRecipe({ version: 1, compose_file: 'docker-compose.yml', services: { web: { role: 'web', port: 5173 }, api: { role: 'api' }, db: { role: 'db' } } });
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('starts an approved branch and runs Docker from the checked, host-owned configuration', async () => {
    const m = manager();
    const r = await m.start('shop', 'main', 'run_1');
    assert.equal(r.key, envKeyFor('shop', 'main'));
    assert.equal(r.runKey, 'run_1');
    assert.deepEqual(r.web, { service: 'web', port: 5173 });

    const hostDir = path.join(stateDir(), 'host', 'compose', r.key);
    const up = ups()[0];
    assert.deepEqual(up.args.slice(0, 3), ['compose', '-p', `moag-${r.key}`]);
    assert.equal(argAfter(up.args, '-f'), path.join(hostDir, 'resolved.json'), 'up runs the checked copy');
    assert.equal(up.args.includes(r.composeFile), false, 'never the branch\'s compose file');
    assert.ok(!up.cwd!.startsWith(r.worktree), 'not run from inside the checkout');
    // What was checked is what runs.
    const resolved = JSON.parse(fs.readFileSync(path.join(hostDir, 'resolved.json'), 'utf-8'));
    assert.equal(resolved.services.web.ports[0].published, String(r.port));
    // State survives a restart of the agent.
    assert.equal(manager().get(r.key)?.branch, 'main');
  });

  it('never gives docker or git anything beyond the environment allow-list, and never the branch .env', async () => {
    await manager().start('shop', 'main');
    assert.ok(calls.length > 5);
    for (const c of calls) {
      for (const secret of ['MOAG_ONOSOO_KEY', 'TUNNEL_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
        assert.equal(c.env?.[secret], undefined, `${secret} reached ${c.command} ${c.args.join(' ')}`);
      }
      assert.equal(c.env?.PATH, '/bin');
    }
    for (const c of calls.filter((x) => x.command === 'docker' && x.args[0] === 'compose')) {
      const envFile = argAfter(c.args, '--env-file');
      assert.ok(envFile, `no --env-file on ${c.args.join(' ')}`);
      assert.equal(fs.readFileSync(envFile!, 'utf-8'), '', 'the env file is empty');
    }
  });

  it('runs every git call hardened, with an explicit repository, never inside the project or a checkout', async () => {
    const m = manager();
    await m.start('shop', 'main');
    await m.start('shop', 'main'); // refresh: the checkout exists now
    const git = calls.filter((c) => c.command === 'git');
    assert.ok(git.length >= 8);
    for (const c of git) {
      const a = gitArgs(c.args);
      assert.ok(c.args.includes('core.fsmonitor=false'), c.args.join(' '));
      assert.ok(c.args.some((x) => x.startsWith('core.hooksPath=')), 'hooks disabled');
      assert.ok(c.args.includes('protocol.allow=never'));
      assert.equal(c.env?.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(c.env?.GIT_TERMINAL_PROMPT, '0');
      if (a[0] !== 'clone' && a[0] !== '--version') { assert.ok(c.args.includes('--git-dir'), `no explicit --git-dir: ${a.join(' ')}`); }
      // Never run inside the project or any checkout, where discovery could find a planted repo.
      assert.notEqual(path.resolve(c.cwd ?? ''), path.resolve(projectDir));
      assert.ok(!path.resolve(c.cwd ?? '').startsWith(path.resolve(config.worktreesDir)), `git ran in a checkout: ${a.join(' ')}`);
      // The project path appears only as the source of a clone/fetch.
      const local = c.args.includes('protocol.file.allow=always');
      assert.equal(local, a[0] === 'clone' || (a[0] === 'fetch' && a.includes(projectDir)), a.join(' '));
      if (a[0] !== 'clone' && a[0] !== 'fetch') { assert.equal(c.args.some((x) => x.includes(projectDir)), false, a.join(' ')); }
    }
  });

  it('updates an existing checkout through the mirror\'s gitdir, ignoring a rewritten .git file', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    fs.writeFileSync(path.join(r.worktree, '.git'), 'gitdir: /tmp/attacker-controlled\n');
    calls = [];
    await m.start('shop', 'main');
    const checkout = calls.find((c) => c.command === 'git' && gitArgs(c.args)[0] === 'checkout')!;
    assert.equal(argAfter(checkout.args, '--git-dir'), path.join(stateDir(), 'host', 'repos', 'shop.git', 'worktrees', r.key));
    assert.equal(argAfter(checkout.args, '--work-tree'), r.worktree);
    assert.equal(calls.some((c) => c.args.some((x) => x.includes('attacker-controlled'))), false);
  });

  it('refuses a compose file that would let a container out, and starts nothing', async () => {
    for (const change of [
      (c: { services: Record<string, Record<string, unknown>> }) => { c.services.api.privileged = true; },
      (c: { services: Record<string, Record<string, unknown>> }) => { c.services.api.volumes = [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }]; },
      (c: { services: Record<string, Record<string, unknown>> }) => { c.services.api.volumes = [{ type: 'bind', source: '/', target: '/host' }]; },
      (c: { services: Record<string, Record<string, unknown>> }) => { c.services.api.network_mode = 'host'; },
      (c: { services: Record<string, Record<string, unknown>> }) => { c.services.api.ports = [{ host_ip: '0.0.0.0', published: '22', target: 22 }]; },
    ]) {
      mutate = change;
      calls = [];
      await assert.rejects(manager().start('shop', 'main'), (e: Error & { kind?: string }) => e.kind === 'rejected' && /asks for more/.test(e.message));
      assert.equal(ups().length, 0, 'never started');
    }
  });

  it('checks the configuration again before restarting a stopped environment', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    await m.stop(r.key);
    // A container rewrote the branch's compose file while it ran: now it asks for privileged mode.
    mutate = (c) => { c.services.api.privileged = true; };
    calls = [];
    await assert.rejects(m.restart(r.key, null), /asks for more/);
    assert.equal(ups().length, 0);
    assert.equal(m.get(r.key)?.desired, 'stopped');
  });

  it('checks the configuration again before a database reset brings the stack back up', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    mutate = (c) => { c.services.db.volumes = [{ type: 'bind', source: '/etc', target: '/etc2' }]; };
    calls = [];
    await assert.rejects(m.resetDb(r.key), /asks for more/);
    assert.equal(ups().length, 0);
  });

  it('allows bind mounts inside the branch checkout', async () => {
    const key = envKeyFor('shop', 'main');
    mutate = (c) => { c.services.api.volumes = [{ type: 'bind', source: path.join(config.worktreesDir, key, 'src'), target: '/app/src' }]; };
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

  it('refuses a branch that is not in the project yet', async () => {
    await assert.rejects(manager().start('shop', 'feat/missing'), /not in the project yet/);
  });

  it('enforces the running limit — also when restarting a stopped one — but a refresh is always allowed', async () => {
    const m = manager({ maxEnvironments: 1 });
    const a = await m.start('shop', 'main');
    await m.start('shop', 'main'); // refresh
    await assert.rejects(m.start('shop', 'feat/a'), /limit/);
    await m.stop(a.key);
    const b = await m.start('shop', 'feat/a');
    await assert.rejects(m.restart(a.key, null), /limit/);
    assert.notEqual(a.port, b.port);
  });

  it('never gives two concurrent starts the same port, and counts them against the limit', async () => {
    const m = manager({ maxEnvironments: 2 });
    const results = await Promise.allSettled([m.start('shop', 'feat/a'), m.start('shop', 'feat/b'), m.start('shop', 'feat/c')]);
    const started = results.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof m.start>>> => x.status === 'fulfilled').map((x) => x.value);
    assert.equal(started.length, 2);
    assert.notEqual(started[0].port, started[1].port);
    assert.match(String((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason), /limit/);
  });

  it('keeps at most MAX_RECORDS environments, stopped ones included', async () => {
    const m = manager({ maxEnvironments: 100 });
    const records = (m as unknown as { records: Map<string, unknown> }).records;
    for (let i = 0; i < MAX_RECORDS; i++) { records.set(`fake-${i}`, { key: `fake-${i}`, desired: 'stopped', port: 1 + i }); }
    await assert.rejects(m.start('shop', 'main'), /50 environments/);
  });

  it('records a failed start with the reason, for the manager to read', async () => {
    upResult = failed('Error: port is already allocated');
    const m = manager();
    await assert.rejects(m.start('shop', 'main'), /Starting failed/);
    const r = m.list()[0];
    assert.equal(r.status, 'failed');
    assert.match(r.message ?? '', /port is already allocated/);
  });

  it('turns a docker process that blows up (e.g. an output overflow) into a failed start, not a hang', async () => {
    const m = manager({}, {
      exec: async (command, args, opts) => {
        if (command === 'docker' && args.includes('up')) { throw new Error('stdout maxBuffer length exceeded'); }
        return exec(command, args, opts);
      },
    });
    await assert.rejects(m.start('shop', 'main'), /maxBuffer/);
    assert.equal(m.list()[0].status, 'failed');
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

  it('resets the database with the recipe command, or by recreating volumes after a fresh check', async () => {
    const m = manager();
    const r = await m.start('shop', 'main');
    calls = [];
    await m.resetDb(r.key);
    assert.ok(calls.some((c) => c.args.includes('down') && c.args.includes('--volumes')));
    assert.ok(calls.some((c) => c.args.includes('config') && c.args.includes('json')), 'checked again before up');
    writeRecipe({ version: 1, services: { web: { role: 'web', port: 5173 } }, reset_db: { service: 'api', command: ['npm', 'run', 'db:reset'] } });
    calls = [];
    await m.resetDb(r.key);
    const execCall = calls.find((c) => c.args.includes('exec'))!;
    assert.deepEqual(execCall.args.slice(-5), ['-T', 'api', 'npm', 'run', 'db:reset']);
  });

  it('checks docker compose and git versions', async () => {
    assert.equal(await manager().checkPrerequisites(), null);
    const old = manager({}, { exec: async (c, a, o) => (c === 'git' && a.includes('--version') ? ok('git version 2.39.5') : exec(c, a, o)) });
    assert.match(String(await old.checkPrerequisites()), /2\.45\.1/);
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
