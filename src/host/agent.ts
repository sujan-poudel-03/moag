// ─── Host agent: the loop ───
//
//   every 5 s    poll ONOSOO for env-* commands, run them one at a time per environment, report
//   every 30 s   refresh every environment from Docker and send the snapshot
//   every 60 s   stop environments nobody has opened for `idle_stop_minutes`
//   every 10 min re-send the capabilities (host_agent, preview_domain)
//   gateway      re-checks preview sessions with ONOSOO on its own timer
//
// A 401 from ONOSOO means this machine was revoked: the agent closes every preview session, stops
// polling and exits; environments keep running until someone stops them on the machine.
// Imports no vscode.

import type { OnosooConfig } from '../headless/onosoo-config';
import { createRedactor, readEnvFileSecrets } from '../utils/redact';

import { EnvError, type EnvironmentManager } from './environments';
import type { Gateway } from './gateway';
import type { HostConfig } from './host-config';
import type { OnosooCall } from './onosoo-client';
import type { CommandOutcome, HostCommand, ProjectsLoader } from './types';

export const ENV_COMMAND_KINDS = ['env-start', 'env-stop', 'env-restart', 'env-reset-db'] as const;
const POLL_MS = 5_000;
const SNAPSHOT_MS = 30_000;
const IDLE_MS = 60_000;
const CAPABILITIES_MS = 10 * 60_000;
export const REVOKED_HOST_MESSAGE = 'ONOSOO refused this machine\'s key (revoked or wrong). Re-pair the machine in ONOSOO, then restart "moag host".';

export interface AgentDeps {
  config: HostConfig;
  onosoo: Pick<OnosooConfig, 'key' | 'deviceId' | 'stateDir'>;
  call: OnosooCall;
  manager: EnvironmentManager;
  gateway: Gateway;
  loadProjects: ProjectsLoader;
  moagVersion: string;
  log?: (line: string) => void;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export class HostAgent {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private revoked = false;
  private readonly log: (line: string) => void;
  /** Commands being run, so a slow env-start never blocks the poll for others. */
  private inFlight = new Set<string>();
  private onRevoked: (() => void) | null = null;

  constructor(private readonly deps: AgentDeps) {
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
  }

  /** The env-file values and machine key a log text must never contain. */
  redactLogs(envKey: string, text: string): string {
    const r = this.deps.manager.get(envKey);
    const project = r ? this.deps.loadProjects(this.deps.onosoo.stateDir).projects.find((p) => p.id === r.projectId) : undefined;
    const secrets = [
      this.deps.onosoo.key,
      ...(r ? readEnvFileSecrets(r.worktree) : []),
      ...(project ? readEnvFileSecrets(project.path) : []),
    ];
    return createRedactor(secrets).redact(text).text;
  }

  /** Status JSON the gateway serves, the same shape as a snapshot entry. */
  statusOf(envKey: string): unknown {
    return this.snapshot().find((e) => e.env_key === envKey) ?? null;
  }

  snapshot(): Record<string, unknown>[] {
    return this.deps.manager.list().map((r) => ({
      env_key: r.key,
      project_id: r.projectId,
      project_name: r.projectName,
      branch: r.branch,
      run_id: r.runKey,
      status: r.status,
      preview_host: r.web ? `${r.key}.${this.deps.config.previewDomain}` : null,
      services: this.deps.manager.services(r.key),
      started_at: r.startedAt,
      message: r.message,
    }));
  }

  private checkRevoked(status: number): boolean {
    if (status !== 401 || this.revoked) { return status === 401; }
    this.revoked = true;
    this.log(`moag host: ${REVOKED_HOST_MESSAGE}`);
    this.deps.gateway.sessions.applyMembership({});
    this.onRevoked?.();
    return true;
  }

  async sendCapabilities(): Promise<void> {
    const r = await this.deps.call('events', {
      protocol: 1,
      device_id: this.deps.onosoo.deviceId,
      moag_version: this.deps.moagVersion,
      events: [],
      // Only the keys the host agent owns: the relay reports remote_start, projects and engines.
      capabilities: { host_agent: true, preview_domain: this.deps.config.previewDomain },
    }).catch(() => null);
    if (r) { this.checkRevoked(r.status); }
  }

  async sendSnapshot(): Promise<void> {
    await this.deps.manager.refresh();
    const r = await this.deps.call('environments', { environments: this.snapshot() }).catch(() => null);
    if (r) { this.checkRevoked(r.status); }
  }

  /** Run one command and turn the outcome into a result ONOSOO can show a manager. */
  async runCommand(cmd: HostCommand): Promise<CommandOutcome> {
    const p = cmd.payload;
    try {
      switch (cmd.kind) {
        case 'env-start': {
          const projectId = str(p.project_id);
          const branch = str(p.branch);
          if (!projectId || !branch) { return { status: 'rejected', message: 'The command was missing its project or branch.' }; }
          const env = await this.deps.manager.start(projectId, branch, str(p.run_id));
          return { status: 'succeeded', message: env.web ? `Running at https://${env.key}.${this.deps.config.previewDomain}` : 'Running (this project has no web service to preview).' };
        }
        case 'env-stop': {
          const key = str(p.environment_id);
          if (!key) { return { status: 'rejected', message: 'The command did not say which environment.' }; }
          await this.deps.manager.stop(key, cmd.requested_by ? `Stopped by ${cmd.requested_by}.` : null);
          this.deps.gateway.sessions.dropEnvironment(key);
          return { status: 'succeeded', message: 'Stopped.' };
        }
        case 'env-restart': {
          const key = str(p.environment_id);
          if (!key) { return { status: 'rejected', message: 'The command did not say which environment.' }; }
          await this.deps.manager.restart(key, str(p.service));
          return { status: 'succeeded', message: p.service ? `Restarted ${String(p.service)}.` : 'Restarted.' };
        }
        case 'env-reset-db': {
          const key = str(p.environment_id);
          if (!key) { return { status: 'rejected', message: 'The command did not say which environment.' }; }
          await this.deps.manager.resetDb(key);
          return { status: 'succeeded', message: 'Database reset.' };
        }
        default:
          return { status: 'rejected', message: 'The host agent does not handle that command.' };
      }
    } catch (err) {
      if (err instanceof EnvError) { return { status: err.kind, message: err.message }; }
      this.log(`moag host: ${cmd.kind} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return { status: 'failed', message: 'Something went wrong on the machine; see the host agent\'s log.' };
    }
  }

  private async report(id: string, outcome: CommandOutcome): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.deps.call(`commands/${id}/result`, outcome).catch(() => null);
      if (r && (r.status === 200 || r.status === 404 || r.status === 409)) { return; } // done, or nothing left to tell
      if (r && this.checkRevoked(r.status)) { return; }
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    this.log(`moag host: could not report the result of command ${id}.`);
  }

  async pollOnce(): Promise<void> {
    const r = await this.deps.call('commands/poll', { kinds: ENV_COMMAND_KINDS }).catch(() => null);
    if (!r || this.checkRevoked(r.status) || r.status !== 200) { return; }
    const commands = Array.isArray(r.json?.commands) ? r.json!.commands as HostCommand[] : [];
    for (const cmd of commands) {
      if (!cmd || typeof cmd.id !== 'string' || this.inFlight.has(cmd.id)) { continue; }
      if (!(ENV_COMMAND_KINDS as readonly string[]).includes(cmd.kind)) { continue; }
      this.inFlight.add(cmd.id);
      void (async () => {
        try {
          if (cmd.kind === 'env-start') { await this.report(cmd.id, { status: 'running', message: 'Starting…' }); }
          const outcome = await this.runCommand({ ...cmd, payload: cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {} });
          await this.report(cmd.id, outcome);
          await this.sendSnapshot();
        } finally {
          this.inFlight.delete(cmd.id);
        }
      })();
    }
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    const loop = async (): Promise<void> => {
      if (this.stopped || this.revoked) { return; }
      try {
        await fn();
      } catch (err) {
        this.log(`moag host: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopped && !this.revoked) { this.timers.push(setTimeout(() => { void loop(); }, ms)); }
    };
    void loop();
  }

  /** Start the loops. Resolves when the agent stops (revoked, or stop() called). */
  run(): Promise<'revoked' | 'stopped'> {
    return new Promise((resolve) => {
      // Resolve first: stop() also fires onStopped, and the first resolve wins.
      this.onRevoked = () => { resolve('revoked'); this.stop(); };
      this.onStopped = () => resolve('stopped');
      this.every(CAPABILITIES_MS, () => this.sendCapabilities());
      this.every(SNAPSHOT_MS, () => this.sendSnapshot());
      this.every(POLL_MS, () => this.pollOnce());
      this.every(IDLE_MS, async () => {
        for (const key of await this.deps.manager.idleSweep()) { this.deps.gateway.sessions.dropEnvironment(key); }
      });
      this.deps.gateway.startRecheck();
    });
  }

  private onStopped: (() => void) | null = null;

  stop(): void {
    if (this.stopped) { return; }
    this.stopped = true;
    for (const t of this.timers) { clearTimeout(t); }
    this.timers = [];
    this.deps.gateway.stopRecheck();
    this.onStopped?.();
  }
}
