// ─── `moag host` ───
//
//   moag host [run]            run the host agent: environments, gateway, tunnel, ONOSOO loops
//   moag host init             write host.json (and an empty projects.json) to the user config folder
//   moag host draft <project>  draft .moag/environment.draft.json for an approved project
//   moag host status           what is configured and what runs, without contacting ONOSOO
//   moag host stop <env>       stop an environment from the machine itself
//   moag host remove <env>     remove one: containers, volumes, worktree
//
// Config, all user-level in <configDir>/moag (never in a workspace):
//   onosoo.json   key + url (or MOAG_ONOSOO_KEY / MOAG_ONOSOO_URL, captured by main() and handed in
//                 here as `env` — they are no longer in process.env, so no child can inherit them)
//   projects.json approved projects (src/headless/onosoo-projects.ts owns the format)
//   host.json     preview domain, gateway port, limits, optional tunnel token file (host-config.ts)
//
// Exit codes: 0 stopped · 2 configuration or usage error · 3 the machine key was refused.
// Imports no vscode.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveOnosooConfig, userConfigDir } from '../headless/onosoo-config';
import { loadApprovedProjects } from '../headless/onosoo-projects';
import { readMoagVersion } from '../headless/onosoo-relay';
import { execFileAsync } from '../utils/exec-file';

import { HostAgent } from './agent';
import { childEnv } from './compose';
import { dockerChildEnv, prepareHostDockerConfig } from './docker-config';
import { EnvironmentManager, type Exec } from './environments';
import { Gateway } from './gateway';
import { HOST_CONFIG_FILE, HOST_CONFIG_TEMPLATE, loadHostConfig } from './host-config';
import { createOnosooClient } from './onosoo-client';
import { DRAFT_FILE, draftFromCompose, draftFromPackageJson, findComposeFile, GENERATED_COMPOSE, RECIPE_FILE } from './recipe';
import { Tunnel } from './tunnel';
import type { ProjectsLoader } from './types';

const USAGE =
  'Usage: moag host [run | init | draft <project> | status | stop <env> | remove <env>]\n' +
  '  See docs/host-agent.md.\n';

const out = (s: string): void => { process.stdout.write(s); };
const err = (s: string): void => { process.stderr.write(s); };

const exec: Exec = (command, args, opts) => execFileAsync(command, args, opts);

export interface HostCliDeps {
  loadProjects?: ProjectsLoader;
  platform?: NodeJS.Platform;
}

function stateDirFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return path.join(userConfigDir(env, platform, os.homedir), 'moag');
}

function writeIfAbsent(file: string, content: string): boolean {
  if (fs.existsSync(file)) { return false; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}

function cmdInit(stateDir: string): number {
  const host = path.join(stateDir, HOST_CONFIG_FILE);
  const projects = path.join(stateDir, 'projects.json');
  out(writeIfAbsent(host, HOST_CONFIG_TEMPLATE) ? `Wrote ${host}\n` : `${host} already exists; left as it is.\n`);
  const template = JSON.stringify({ version: 1, remote_start: false, daily_budget_usd: null, runner_user: null, projects: [] }, null, 2) + '\n';
  out(writeIfAbsent(projects, template) ? `Wrote ${projects}\n` : `${projects} already exists; left as it is.\n`);
  out('\nNext:\n'
    + `  1. Set "preview_domain" in ${host}.\n`
    + `  2. Add projects to ${projects}: { "id", "name", "path" } for each folder this machine may run.\n`
    + '  3. For each project: moag host draft <id>, check the draft, save it as .moag/environment.json.\n'
    + '  4. moag host\n');
  return 0;
}

async function cmdDraft(stateDir: string, projectId: string | undefined, loadProjects: ProjectsLoader): Promise<number> {
  if (!projectId) { err(USAGE); return 2; }
  const project = loadProjects(stateDir).projects.find((p) => p.id === projectId);
  if (!project) { err(`"${projectId}" is not in projects.json.\n`); return 2; }

  const recipeFile = path.join(project.path, RECIPE_FILE);
  if (fs.existsSync(recipeFile)) { out(`${recipeFile} already exists. Delete it first to draft a new one.\n`); return 0; }

  const composeName = findComposeFile((n) => fs.existsSync(path.join(project.path, n)));
  let draft;
  if (composeName) {
    const listed = await exec('docker', ['compose', '-f', composeName, 'config', '--services'], { cwd: project.path, env: dockerChildEnv(childEnv(process.env), prepareHostDockerConfig(stateDir, process.env)), timeoutMs: 60_000 });
    if (listed.exitCode !== 0) { err(`docker compose could not read ${composeName}:\n${listed.stderr}\n`); return 2; }
    draft = draftFromCompose(composeName, listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } else {
    let pkg: string | null = null;
    try { pkg = fs.readFileSync(path.join(project.path, 'package.json'), 'utf-8'); } catch { /* none */ }
    draft = pkg ? draftFromPackageJson(pkg) : null;
    if (!draft) {
      err('This project has no compose file and no recognised dev server. Add a docker-compose.yml that starts it, then run this again.\n');
      return 2;
    }
    if (draft.generatedCompose) {
      const gen = path.join(project.path, GENERATED_COMPOSE);
      out(writeIfAbsent(gen, draft.generatedCompose) ? `Wrote ${gen}\n` : `${gen} already exists; the draft uses it as it is.\n`);
    }
  }
  const draftFile = path.join(project.path, DRAFT_FILE);
  fs.mkdirSync(path.dirname(draftFile), { recursive: true });
  fs.writeFileSync(draftFile, JSON.stringify(draft.recipe, null, 2) + '\n');
  out(`Wrote ${draftFile}\n\n${draft.notes.map((n) => `- ${n}`).join('\n')}\n\nWhen it is right, rename it to ${RECIPE_FILE.replace(/\\/g, '/')}. Nothing runs from a draft.\n`);
  return 0;
}

function managerFor(stateDir: string, loadProjects: ProjectsLoader): EnvironmentManager | string {
  const hc = loadHostConfig(stateDir);
  if (!hc.ok) { return hc.error; }
  return new EnvironmentManager({ exec, config: hc.config, stateDir, loadProjects });
}

function cmdStatus(stateDir: string, loadProjects: ProjectsLoader): number {
  const hc = loadHostConfig(stateDir);
  out(hc.ok ? `Preview domain: ${hc.config.previewDomain}\nGateway: 127.0.0.1:${hc.config.gatewayPort}\nTunnel: ${hc.config.tunnelTokenFile ? 'run by moag host' : 'run separately'}\n` : `${hc.error}\n`);
  const projects = loadProjects(stateDir);
  out(`Remote start: ${projects.remoteStart ? 'on' : 'off'}\nApproved projects: ${projects.projects.map((p) => p.id).join(', ') || 'none'}\n`);
  for (const e of projects.errors) { out(`  ! ${e}\n`); }
  for (const p of projects.projects) {
    out(`  ${p.id}: ${fs.existsSync(path.join(p.path, RECIPE_FILE)) ? 'recipe approved' : 'no recipe (moag host draft ' + p.id + ')'}\n`);
  }
  if (hc.ok) {
    const m = new EnvironmentManager({ exec, config: hc.config, stateDir, loadProjects });
    const envs = m.list();
    out(`Environments: ${envs.length === 0 ? 'none' : ''}\n`);
    for (const r of envs) { out(`  ${r.key}  ${r.projectId} @ ${r.branch}  ${r.desired}${r.message ? `  (${r.message})` : ''}\n`); }
  }
  return 0;
}

async function cmdRun(env: NodeJS.ProcessEnv, stateDir: string, loadProjects: ProjectsLoader, platform: NodeJS.Platform): Promise<number> {
  if (platform === 'win32') {
    // Paths, permissions and the Docker socket all behave differently on native Windows, and none of
    // the hardening here was designed or tested for it.
    err('moag host runs on Linux. On Windows, install it inside WSL2 Ubuntu and run it there (docs/host-agent.md).\n');
    return 2;
  }
  const onosoo = resolveOnosooConfig({ env, cwd: process.cwd(), stderr: err });
  if (!onosoo) {
    err('No ONOSOO device key. Pair this machine in ONOSOO (Builds → Pair machine) and set MOAG_ONOSOO_KEY and MOAG_ONOSOO_URL, or put them in onosoo.json.\n');
    return 2;
  }
  const hc = loadHostConfig(onosoo.stateDir);
  if (!hc.ok) { err(`${hc.error}\n`); return 2; }
  const config = hc.config;

  const manager = new EnvironmentManager({ exec, config, stateDir: onosoo.stateDir, loadProjects });
  const prereqProblem = await manager.checkPrerequisites();
  if (prereqProblem) { err(`${prereqProblem}\n`); return 2; }

  const call = createOnosooClient(onosoo);
  let agent: HostAgent | null = null;
  const gateway = new Gateway({
    previewDomain: config.previewDomain,
    appUrl: config.appUrl,
    appOrigins: config.appOrigins,
    call,
    environment: (key) => manager.get(key),
    status: (key) => agent?.statusOf(key) ?? null,
    logs: async (key, service, lines) => (agent ? agent.redactLogs(key, await manager.logs(key, service, lines)) : ''),
    touch: (key) => manager.touch(key),
  });
  agent = new HostAgent({ config, onosoo, call, manager, gateway, loadProjects, moagVersion: readMoagVersion() });

  try {
    await gateway.listen(config.gatewayPort);
  } catch (e) {
    err(`The gateway could not listen on 127.0.0.1:${config.gatewayPort}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const tunnel = config.tunnelTokenFile ? new Tunnel({ tokenFile: config.tunnelTokenFile }) : null;
  tunnel?.start();

  out(`moag host: gateway on 127.0.0.1:${config.gatewayPort} for *.${config.previewDomain}; ${tunnel ? 'tunnel started' : 'expecting a separately run tunnel'}.\n`);
  const shutdown = (): void => { agent?.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const why = await agent.run();
  tunnel?.stop();
  await gateway.close();
  out(why === 'revoked' ? 'moag host: stopped — the machine key was refused.\n' : 'moag host: stopped. Environments keep running.\n');
  return why === 'revoked' ? 3 : 0;
}

/** Entry from headless/cli.ts main(). `env` is process.env with main()'s captured relay variables. */
export async function cmdHost(argv: string[], env: NodeJS.ProcessEnv, deps: HostCliDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const stateDir = stateDirFor(env, platform);
  // The approved-projects loader is the relay side's (src/headless/onosoo-projects.ts): one list,
  // one set of rules, for remote runs and environments alike.
  const loadProjects: ProjectsLoader = deps.loadProjects ?? ((dir) => loadApprovedProjects(dir, { platform }));

  const [sub, arg] = argv;
  switch (sub ?? 'run') {
    case 'run': return cmdRun(env, stateDir, loadProjects, platform);
    case 'init': return cmdInit(stateDir);
    case 'draft': return cmdDraft(stateDir, arg, loadProjects);
    case 'status': return cmdStatus(stateDir, loadProjects);
    case 'stop':
    case 'remove': {
      if (!arg) { err(USAGE); return 2; }
      const m = managerFor(stateDir, loadProjects);
      if (typeof m === 'string') { err(`${m}\n`); return 2; }
      try {
        if (sub === 'stop') { await m.stop(arg, 'Stopped on the machine.'); } else { await m.remove(arg); }
        out(`${sub === 'stop' ? 'Stopped' : 'Removed'} ${arg}.\n`);
        return 0;
      } catch (e) {
        err(`${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
    }
    default:
      err(USAGE);
      return 2;
  }
}
