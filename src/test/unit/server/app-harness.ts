// ─── Shared harness for the hosted-server HTTP tests (not a test file itself) ───
//
// Boots `createApp` on port 0 against a temp data dir, with a FAKE worker
// spawner (no child processes) and a stubbed git runner. Users are created once
// per harness; sessions are minted directly so role tests don't pay for scrypt.

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { AddressInfo } from 'net';
import { createApp, App } from '../../../server/app';
import { ServerConfig } from '../../../server/config';
import { UserStore, UserRecord } from '../../../server/users';
import { SessionStore } from '../../../server/sessions';
import { AuditLog, AuditEntry } from '../../../server/audit';
import { ProjectStore } from '../../../server/projects';
import { ProjectStateStore } from '../../../server/project-state';
import { LoginRateLimiter } from '../../../server/rate-limit';
import { SpawnSpec, WorkerProcess } from '../../../server/jobs';
import { WorkerJob } from '../../../server/worker-protocol';
import { WebRole } from '../../../server/web-roles';
import { verifyPassword } from '../../../server/passwords';
import { SecretStore } from '../../../server/secrets';

export const PASSWORD = 'Correct-Horse-Battery-9';

export class FakeWorker extends EventEmitter implements WorkerProcess {
  pid = 424242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  sent: unknown[] = [];
  constructor(public readonly spec: SpawnSpec, public readonly job: WorkerJob) { super(); }
  send(m: unknown): boolean { this.sent.push(m); return true; }
  line(o: Record<string, unknown>): void { this.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')); }
  exit(code: number | null): void { this.emit('close', code); }
}

export interface Resp { status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders; raw: string; }

export interface ReqOpts {
  as?: string;
  body?: unknown;
  /** false = omit the CSRF header; a string = send that value. Default: the session's token. */
  csrf?: false | string;
  headers?: Record<string, string>;
  contentType?: string;
  cookie?: string;
}

export interface Harness {
  url: string;
  app: App;
  config: ServerConfig;
  dataDir: string;
  root: string;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditLog;
  projects: ProjectStore;
  state: ProjectStateStore;
  accounts: Record<string, UserRecord>;
  tokens: Record<string, { sid: string; csrfToken: string }>;
  workers: FakeWorker[];
  /** Called for every spawned fake worker (set per test). */
  onSpawn: (w: FakeWorker) => void;
  verifyCalls: () => number;
  login(name: string): void;
  /** Wait until the project's plan generation has finished and been recorded. */
  waitDone(projectId: string): Promise<void>;
  request(method: string, p: string, opts?: ReqOpts): Promise<Resp>;
  auditEntries(): AuditEntry[];
  close(): Promise<void>;
}

export const ROLE_ACCOUNTS: Record<string, WebRole[]> = {
  po: ['product-owner'],
  reviewer: ['reviewer'],
  approver: ['approver'],
  admin: ['admin'],
};

export async function startHarness(over: {
  config?: Partial<ServerConfig>;
  extraAccounts?: Record<string, WebRole[]>;
  /** Replace the default role accounts (e.g. `{}` for a fresh, admin-less server). */
  accounts?: Record<string, WebRole[]>;
  /** Serve the front-end from this directory instead of the repo's `web/`. */
  webRoot?: string;
  /** Engine probe stand-in (undefined = unknown). */
  engineAvailable?: (engine: string) => boolean | undefined;
  /** Build the key store against the harness data dir (default: the app's own, no master key). */
  secrets?: (dataDir: string) => SecretStore;
  /** Stand-in for the scrypt saturation check (default: the real one). */
  scryptSaturated?: () => boolean;
  /** SSE heartbeat / session re-check interval (default: the app's 25 s). */
  sseHeartbeatMs?: number;
} = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-app-'));
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'workspaces');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'acme'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });

  const config: ServerConfig = {
    dataDir, projectsRoot: root, publicUrl: 'http://127.0.0.1/', publicOrigin: 'http://127.0.0.1', secureCookies: false,
    host: '127.0.0.1', port: 0, trustProxy: false, bootstrapToken: null, masterKey: null, maxConcurrentJobs: 4,
    runEnvPassthrough: [], allowSshClone: false, runsDisabledReason: null,
    ...(over.config ?? {}),
  };

  const users = new UserStore(dataDir);
  const sessions = new SessionStore(dataDir);
  const audit = new AuditLog(dataDir);
  const projects = new ProjectStore(dataDir);
  const state = new ProjectStateStore(dataDir);
  let verifyCount = 0;
  const workers: FakeWorker[] = [];

  const h = {} as Harness;
  h.onSpawn = () => { /* default: stay running */ };

  const app = createApp({
    config, users, sessions, audit, projects, state,
    limiter: new LoginRateLimiter(),
    spawnWorker: (spec) => {
      const job = JSON.parse(fs.readFileSync(spec.jobPath, 'utf-8')) as WorkerJob;
      const w = new FakeWorker(spec, job);
      workers.push(w);
      setImmediate(() => h.onSpawn(w));
      return w;
    },
    killProcess: (p) => { (p as FakeWorker).exit(null); },
    serverEnv: { PATH: process.env.PATH, MOAG_MASTER_KEY: 'server-master-secret', CI: 'true', SESSION_SECRET: 'nope' },
    verifyPassword: async (pw, stored) => { verifyCount++; return verifyPassword(pw, stored); },
    // `rev-parse --show-toplevel` answers the `-C` dir itself: every fixture folder is a repo root.
    exec: async (_cmd, args) => ({
      exitCode: 0, stdout: args.includes('--show-toplevel') ? `${args[args.indexOf('-C') + 1]}\n` : 'true\n', stderr: '', timedOut: false,
    }),
    log: () => { /* quiet */ },
    ...(over.webRoot ? { webRoot: over.webRoot } : {}),
    ...(over.engineAvailable ? { engineAvailable: over.engineAvailable } : {}),
    ...(over.secrets ? { secrets: over.secrets(dataDir) } : {}),
    ...(over.scryptSaturated ? { scryptSaturated: over.scryptSaturated } : {}),
    ...(over.sseHeartbeatMs ? { sseHeartbeatMs: over.sseHeartbeatMs } : {}),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const { port } = app.server.address() as AddressInfo;

  const accounts: Record<string, UserRecord> = {};
  const tokens: Record<string, { sid: string; csrfToken: string }> = {};
  const all = { ...(over.accounts ?? ROLE_ACCOUNTS), ...(over.extraAccounts ?? {}) };
  for (const [name, roles] of Object.entries(all)) {
    accounts[name] = await users.create({ username: name, displayName: name, roles, password: PASSWORD });
    tokens[name] = sessions.create(accounts[name]);
  }

  Object.assign(h, {
    url: `http://127.0.0.1:${port}`,
    app, config, dataDir, root, users, sessions, audit, projects, state, accounts, tokens, workers,
    verifyCalls: () => verifyCount,
    waitDone: (projectId: string) => waitFor(() => !app.jobs.isActive(projectId)
      && (state.load(projectId).plans[0]?.status ?? 'generating') !== 'generating'),
    login(name: string) { const u = users.findByUsername(name)!; accounts[name] = u; tokens[name] = sessions.create(u); },
    auditEntries: () => {
      const f = path.join(dataDir, 'audit.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    request(method: string, p: string, opts: ReqOpts = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        const tok = opts.as ? tokens[opts.as] : undefined;
        const cookies: string[] = [];
        if (tok) { cookies.push(`moag_sid=${tok.sid}`); }
        if (opts.cookie) { cookies.push(opts.cookie); }
        if (cookies.length) { headers.Cookie = cookies.join('; '); }
        if (opts.csrf !== false) {
          const v = typeof opts.csrf === 'string' ? opts.csrf : tok?.csrfToken;
          if (v) { headers['X-CSRF-Token'] = v; }
        }
        let payload: string | undefined;
        if (opts.body !== undefined || method !== 'GET') {
          payload = opts.body === undefined ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
          headers['Content-Type'] = opts.contentType ?? 'application/json';
          // Node does not chunk-encode DELETE bodies by default; frame them like a browser does.
          headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        const req = http.request(`${h.url}${p}`, { method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            let body: Record<string, unknown> = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers, raw });
          });
        });
        req.on('error', reject);
        req.end(payload);
      });
    },
    async close() {
      await new Promise<void>((r) => app.server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
  return h;
}

/** Wait until `pred` holds (the job end handlers run asynchronously under the project lock). */
export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) { throw new Error('waitFor timed out'); }
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const PRD_V1 = '# Checkout\n\n## Requirements\n- Guest checkout with email\n- Card payments via Stripe\n';

/** A dehydrated delta playlist with an agent task, a manual ship gate and a release that depends on it. */
export function gatedPlaylist(): Record<string, unknown> {
  return {
    id: 'pl-delta-test', name: 'PRD v1.0.0 delta', autoplay: true,
    tasks: [
      { id: 't-impl', name: 'Implement checkout', prompt: 'do it', requirementIds: ['R-1', 'R-2'] },
      { id: 't-gate', name: 'Release gate', prompt: 'approve the release', type: 'manual', status: 'completed' },
      { id: 't-rel', name: 'Release v1.0.0', prompt: '', type: 'release', dependsOn: ['t-gate'], command: 'npm run release' },
    ],
  };
}

/** Script a plan-generation worker: write the outcome file and exit 0. */
export function planWorker(outcome: Record<string, unknown>): (w: FakeWorker) => void {
  return (w) => {
    if (w.job.kind !== 'plan') { return; }
    fs.mkdirSync(path.dirname(w.job.outPath), { recursive: true });
    fs.writeFileSync(w.job.outPath, JSON.stringify(outcome));
    w.line({ event: 'plan-outcome', kind: outcome.kind });
    w.exit(0);
  };
}

/** Create a project (default engine `engine`), save PRD v1, generate + approve the gated playlist. Returns ids. */
export async function approvedProject(h: Harness, engine = 'claude'): Promise<{ projectId: string; planId: string }> {
  const created = await h.request('POST', '/api/projects', {
    as: 'po', body: { name: 'Acme', source: { kind: 'path', path: 'acme' }, stack: 'node-ts', defaultEngine: engine },
  });
  if (created.status !== 201) { throw new Error(`create: ${created.status} ${created.raw}`); }
  const projectId = (created.body.project as { id: string }).id;
  const saved = await h.request('POST', `/api/projects/${projectId}/prd/versions`, { as: 'po', body: { text: PRD_V1, baseCreatedAt: null } });
  if (saved.status !== 201) { throw new Error(`save: ${saved.status} ${saved.raw}`); }
  h.onSpawn = planWorker({ kind: 'appended', playlist: gatedPlaylist(), rejected: [] });
  const gen = await h.request('POST', `/api/projects/${projectId}/plans`, { as: 'po', body: { mode: 'initial' } });
  if (gen.status !== 202) { throw new Error(`generate: ${gen.status} ${gen.raw}`); }
  const planId = (gen.body.plan as { id: string }).id;
  await waitFor(() => h.state.load(projectId).plans[0]?.status === 'pending');
  const hash = h.state.load(projectId).plans[0].contentHash;
  const ap = await h.request('POST', `/api/projects/${projectId}/plans/${planId}/approve`, { as: 'reviewer', body: { contentHash: hash } });
  if (ap.status !== 200) { throw new Error(`approve: ${ap.status} ${ap.raw}`); }
  h.onSpawn = () => { /* default */ };
  return { projectId, planId };
}
