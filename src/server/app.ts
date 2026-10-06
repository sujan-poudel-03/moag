// ─── Hosted server HTTP application ───
//
// `createApp(deps)` wires the stores, the job manager and the route table into
// a `node:http` server (not yet listening). Every request goes through one
// pipeline, in this order:
//
//   security headers → route match → session / pre-auth → must-change-password
//   → CSRF + Origin (mutating) → role check (canPerform) → body validation
//   → resource state checks → side effects → audit
//
// so a request that fails any earlier step can never reach a later one: a
// disallowed role gets 403 before its body is even read, and invalid input
// gets 400 before anything is written or audited. `ROUTES` is plain data so the
// role-matrix test can walk every route × role pair.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { URL } from 'url';
import { ENGINE_IDS, EngineId, Plan, PlanFilePlaylist, SEMVER_BUMPS, StandardsCheckCounts, TaskStatus, TaskType } from '../models/types';
import { STACK_IDS } from './stacks';
import { WEB_ROLES } from './web-roles';
import { dehydratePlan, hydratePlan, loadPlan } from '../models/plan';
import { describeDeltaScope } from '../runner/prd-plan';
import { latestRequirements, requirementStatuses } from '../models/requirement-trace';
import { formatVersionLabel, collectReservedRequirementIds, computeLatestDiff, recommendBump } from '../models/requirements';
import { writeFileAtomicSync } from '../utils/file-io';
import { ServerConfig, isPathInside } from './config';
import { AuditLog, AuditInput, AuditQuery, AUDIT_ACTIONS, AUDIT_MAX_PAGE } from './audit';
import { UserStore, UserRecord, toPublicUser, LastAdminError, UsernameTakenError, InvalidUserInputError, UserNotFoundError } from './users';
import {
  SessionStore, SessionRecord, sessionCookie, clearSessionCookie, preAuthCookie, sessionCookieName, preAuthCookieName,
  newPreAuthToken, safeEqual,
} from './sessions';
import { LoginRateLimiter } from './rate-limit';
import { verifyPassword as realVerifyPassword, DUMMY_HASH, validatePasswordPolicy, isScryptSaturated } from './passwords';
import {
  HttpError, Router, readJsonBody, sendJson, sendError, parseCookies, clientIp, securityHeaders, PARAM_RE,
} from './http-kit';
import { obj, str, opt, nullable, num, bool, oneOf, engineId as engineIdV, bump as bumpV, stack as stackV, roles as rolesV, parseBody, ValidationError, Validator } from './validate';
import {
  ProjectStore, ProjectRecord, ProjectInputError, intakeProject, ExecFn, ProjectIntakeInput, resolveProjectPath,
  buildRepoListing, detectRepoEngineConfig, gitHead,
} from './projects';
import { ProjectStateStore, PlanReview, RunRecord, RunStatus, ProjectState, StandardsReportPhase } from './project-state';
import { JobManager, JobEnd, SpawnSpec, WorkerProcess, JobNotice, redactSecrets } from './jobs';
import { buildWorkerConfig, buildPlanWorkerConfig, buildWorkerEnv, referencedEngines, plannerFileAccessRefusal, PLANNER_LOCKED_ENGINES } from './run-env';
import { ServerSettingsStore } from './server-settings';
import { SecretStore, NoMasterKeyError, isKeyedEngine, API_KEY_RE } from './secrets';
import { EngineStatusCache, buildEngineRows, PROBE_TIMEOUT_MS } from './engines';
import { OutcomeStore } from './outcomes';
import { StackId } from './stacks';
import { recommendStack, detectStackFromRepo } from './stack-recommendation';
import { RunJob, PlanJob, ProbeJob, WorkerEvent, mergeRunViews } from './worker-protocol';
import {
  savePrdVersion, overrideBump, mergeRunSnapshot, validatePendingPlaylist, pendingPlaylistEngineErrors, contentHash, SERVER_FORBIDDEN_ENGINES, appendShipGate,
  stripGeneratedSideEffects, redactStringsDeep, CREDENTIAL_IN_PLAYLIST_ERROR,
} from './prd-ops';
import { prepareGateResume, GateResumeError, GateResumeResult, stampApprovedShip } from './gate';
import { createStaticServer } from './static';
import { ServerAction, canPerform, allowedActions, Actor } from './permissions';
import {
  StandardsStore, StandardsStoreError, StandardsVersionRecord, MAX_STANDARDS_VERSIONS, SYSTEM_ACTOR, inEffectBefore, proposeAutomatic,
  enforcementReview, standardsChangeAudit,
} from './standards-store';
import {
  MAX_STANDARDS_COMMANDS, MAX_STANDARDS_COMMAND_CHARS, MAX_STANDARDS_FREE_TEXT_CHARS, PROVENANCE_FIELDS, ProvenanceField,
  DEFAULT_RULE_SEVERITY, STANDARDS_RULE_IDS, StandardsProfile, StandardsProvenance, renderPlannerStandards, renderStandardsText,
  isScannerRule, ruleSeverity, validateProfile,
} from '../standards/profile';
import type { StandardsJobFile } from '../standards/local-store';
import {
  BlockingSetState, StandardsReport, applyProfileSeverity, commandRow, parseStandardsReport, recountTotals, standardsBlockingState,
  standardsCheckCounts,
} from '../standards/checker';

// ─── Route table (data) ───

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteSpec {
  method: HttpMethod;
  path: string;
  /** Permission checked by the guard; null = any signed-in user (or public, per `auth`). */
  action: ServerAction | null;
  mutating: boolean;
  /** 'none' = public; 'pre' = pre-auth with double-submit CSRF; 'session' = signed in. */
  auth: 'none' | 'pre' | 'session';
}

export const ROUTES: readonly RouteSpec[] = Object.freeze([
  { method: 'GET', path: '/healthz', action: null, mutating: false, auth: 'none' },
  { method: 'GET', path: '/api/bootstrap/status', action: null, mutating: false, auth: 'none' },
  { method: 'POST', path: '/api/bootstrap', action: null, mutating: true, auth: 'pre' },
  { method: 'POST', path: '/api/login', action: null, mutating: true, auth: 'pre' },
  { method: 'POST', path: '/api/logout', action: null, mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/session', action: null, mutating: false, auth: 'none' },
  { method: 'POST', path: '/api/me/password', action: null, mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/admin/users', action: 'users.manage', mutating: false, auth: 'session' },
  { method: 'POST', path: '/api/admin/users', action: 'users.manage', mutating: true, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/users/:id', action: 'users.manage', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/admin/audit', action: 'audit.view', mutating: false, auth: 'session' },
  { method: 'GET', path: '/api/admin/engines', action: 'engines.manage', mutating: false, auth: 'session' },
  { method: 'POST', path: '/api/admin/engines/recheck', action: 'engines.manage', mutating: true, auth: 'session' },
  { method: 'PUT', path: '/api/admin/engines/:engine/key', action: 'engines.manage', mutating: true, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/engines/:engine/key', action: 'engines.manage', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/admin/settings', action: 'engines.manage', mutating: false, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/settings', action: 'engines.manage', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/admin/projects/:id/lock/release', action: 'jobs.force-release', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/engines/availability', action: null, mutating: false, auth: 'session' },
  { method: 'GET', path: '/api/users/approvers', action: null, mutating: false, auth: 'session' },
  { method: 'GET', path: '/api/projects', action: null, mutating: false, auth: 'session' },
  { method: 'POST', path: '/api/projects', action: 'project.create', mutating: true, auth: 'session' },
  // Before `/api/projects/:id`: the router takes the first match.
  { method: 'GET', path: '/api/projects/recommendation', action: null, mutating: false, auth: 'session' },
  { method: 'GET', path: '/api/projects/:id', action: null, mutating: false, auth: 'session' },
  { method: 'PATCH', path: '/api/projects/:id', action: 'project.update', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/projects/:id/prd', action: null, mutating: false, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/prd/versions', action: 'prd.save', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/prd/versions/latest/bump', action: 'prd.bump-override', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/projects/:id/standards', action: null, mutating: false, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/standards/versions', action: 'standards.propose', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/standards/versions/:version/approve', action: 'standards.approve', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/standards/versions/:version/reject', action: 'standards.reject', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/standards/accept-defaults', action: 'standards.accept-defaults', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/plans', action: 'plan.generate', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/plans/:planId/approve', action: 'plan.approve', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/plans/:planId/reject', action: 'plan.reject', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/plans/:planId/cancel', action: 'plan.cancel', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/runs', action: 'run.start', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/runs/:runId/stop', action: 'run.stop', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/runs/:runId/gate/approve', action: 'gate.approve', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/runs/:runId/gate/reject', action: 'gate.reject', mutating: true, auth: 'session' },
  { method: 'POST', path: '/api/projects/:id/runs/:runId/gate/skip', action: 'gate.skip', mutating: true, auth: 'session' },
  { method: 'GET', path: '/api/projects/:id/trace', action: null, mutating: false, auth: 'session' },
  { method: 'GET', path: '/api/projects/:id/events', action: null, mutating: false, auth: 'session' },
] as RouteSpec[]);

/**
 * Actions a route selects from its validated body rather than its path. The
 * route guard checks the route's own action; the handler then checks the
 * variant's. Plain data so the role-matrix test walks these too.
 */
export const ACTION_VARIANTS: readonly { action: ServerAction; method: HttpMethod; path: string; body: Record<string, unknown> }[] = Object.freeze([
  { action: 'plan.generate-initial', method: 'POST', path: '/api/projects/:id/plans', body: { mode: 'initial' } },
] as const);

/** Review statuses that block requesting another plan for the same PRD version. */
const OPEN_PLAN_STATUSES: readonly string[] = ['generating', 'pending', 'approved'];

/** Routes reachable while `mustChangePassword` is set. */
const PASSWORD_CHANGE_ALLOWED = new Set(['GET /api/session', 'POST /api/me/password']);

export const MAX_SSE_PER_SESSION = 5;
export const SSE_HEARTBEAT_MS = 25_000;
export const MAX_RUN_EVENTS_BYTES = 2 * 1024 * 1024;
/** Most recent run events returned with the current run's detail. */
export const RUN_DETAIL_EVENTS = 200;

// ─── Dependencies ───

export interface AppDeps {
  config: ServerConfig;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditLog;
  projects: ProjectStore;
  state: ProjectStateStore;
  limiter: LoginRateLimiter;
  /** Wrong current passwords on POST /api/me/password, keyed by user id; default: a fresh limiter. */
  passwordLimiter?: LoginRateLimiter;
  spawnWorker: (spec: SpawnSpec) => WorkerProcess;
  killProcess: (proc: WorkerProcess) => void;
  /** Workers lead their own process group (POSIX `detached`); the job lock records it. */
  workerLeadsProcessGroup?: boolean;
  /** Liveness probe for job-lock holders (tests inject it); default: `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
  /** The server's environment (already scrubbed of MOAG secrets). */
  serverEnv: NodeJS.ProcessEnv;
  /** Injected for tests (spy); defaults to the scrypt verifier. */
  verifyPassword?: (password: unknown, stored: unknown) => Promise<boolean>;
  /** Injected for tests; defaults to the scrypt semaphore's own saturation check. */
  scryptSaturated?: () => boolean;
  /** git runner for repo intake (tests stub it). */
  exec?: ExecFn;
  /** Whether an engine is usable on this server; undefined = unknown (no probe yet). Default: the probe cache + key store. */
  engineAvailable?: (engine: EngineId) => boolean | undefined;
  now?: () => Date;
  log?: (message: string) => void;
  /** Directory the PO front-end is served from (tests point it at a fixture); default `web/`. */
  webRoot?: string;
  /** Engine API key store; default: `secrets.json` in the data dir under `config.masterKey`. */
  secrets?: SecretStore;
  /** Admin settings store; default: `server-settings.json` in the data dir. */
  settings?: ServerSettingsStore;
  /** Stack evidence store; default: `outcomes.jsonl` in the data dir. */
  outcomes?: OutcomeStore;
  /** Project standards store; default: `projects/<id>/standards.json` in the data dir. */
  standards?: StandardsStore;
  /** SSE heartbeat (and session re-check) interval; default {@link SSE_HEARTBEAT_MS}. Tests shorten it. */
  sseHeartbeatMs?: number;
}

export interface App {
  server: http.Server;
  jobs: JobManager;
  /** Last engine probe (filled by {@link App.probeEngines}). */
  engines: EngineStatusCache;
  /** Start an engine probe job (boot and admin re-check). False when one is running or the job manager refused. */
  probeEngines: () => boolean;
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  ip: string;
  user: UserRecord | null;
  session: SessionRecord | null;
  sid: string | null;
}

type Handler = (ctx: Ctx) => Promise<void>;

/** Engines a server run may use (S1: every engine except custom/copilot). */
const SERVER_ENGINES: EngineId[] = ENGINE_IDS.filter((e) => !SERVER_FORBIDDEN_ENGINES.includes(e));

/** Actions not tied to one resource; `GET /api/session` reports which the user may perform. */
const SESSION_ACTIONS: readonly ServerAction[] = ['project.create', 'users.manage', 'audit.view', 'engines.manage'];

/** Job-manager slot used by the engine probe (not a project id: route params cannot contain `_`). */
export const PROBE_JOB_ID = '__engine-probe';

/** Closed server enumerations the front-end builds its selects from (never a hard-coded copy). */
const SESSION_META = Object.freeze({
  engines: SERVER_ENGINES,
  unsupportedEngines: [...SERVER_FORBIDDEN_ENGINES],
  stacks: [...STACK_IDS],
  roles: [...WEB_ROLES],
  bumps: [...SEMVER_BUMPS],
});

// ─── Body schemas ───

const ID = str(1, 64, PARAM_RE);
const LONG_TEXT = str(1, 2000);

const S = {
  empty: obj({}),
  login: obj({ username: str(1, 64), password: str(1, 1024) }),
  bootstrap: obj({ token: str(1, 512), username: str(1, 64), displayName: opt(str(1, 80)), password: str(1, 1024) }),
  mePassword: obj({ currentPassword: str(1, 1024), newPassword: str(1, 1024) }),
  createUser: obj({ username: str(1, 64), displayName: opt(str(1, 80)), roles: rolesV, password: str(1, 1024) }),
  patchUser: obj({ roles: opt(rolesV), disabled: opt(bool()), password: opt(str(1, 1024)) }),
  patchProject: obj({ name: opt(str(1, 80)), stack: opt(stackV), defaultEngine: opt(engineIdV), versionBudgetUsd: opt(num(0, 100000)) }),
  savePrd: obj({ text: str(0, 200000), baseCreatedAt: nullable(str(1, 64)) }),
  bump: obj({ bump: bumpV, expectedCreatedAt: str(1, 64) }),
  generatePlan: obj({ mode: oneOf(['delta', 'initial'] as const) }),
  approvePlan: obj({ contentHash: str(64, 64, /^[0-9a-f]{64}$/) }),
  rejectPlan: obj({ reason: LONG_TEXT }),
  startRun: obj({ planId: ID }),
  gateApprove: obj({ note: opt(str(0, 2000)) }),
  gateReject: obj({ note: LONG_TEXT }),
  gateSkip: obj({ reason: LONG_TEXT }),
  setKey: obj({ value: str(8, 512, API_KEY_RE) }),
  patchSettings: obj({ allowPlannerFileAccess: opt(bool()) }),
  forceRelease: obj({ reason: LONG_TEXT }),
  // `profile` is checked in full by `validateProfile` (unknown keys, caps, credential shapes);
  // this schema only fixes the envelope.
  proposeStandards: obj({ profile: ((v: unknown) => v) as Validator<unknown>, baseVersion: nullable(num(1, MAX_STANDARDS_VERSIONS, { integer: true })) }),
  // `acknowledgedEnforcementHash` is the reviewer's tick on the enforcement diff: the content
  // hash of the version whose changes they were shown. The store refuses without it whenever
  // the version changes commands, severities or required directories.
  approveStandards: obj({ contentHash: str(64, 64, /^[0-9a-f]{64}$/), acknowledgedEnforcementHash: opt(str(64, 64, /^[0-9a-f]{64}$/)) }),
  rejectStandards: obj({ reason: LONG_TEXT }),
};

/** The profile sections a version is compared by for its "changed from vN" markers. */
const STANDARDS_SECTIONS: readonly (keyof StandardsProfile)[] = [
  'stackTemplateId', 'repoState', 'structure', 'frontend', 'backend', 'naming', 'comments', 'testing',
  'commands', 'builtInRuleIds', 'freeText', 'severity',
];

/** Every rule's severity under a profile, defaults filled in: what the review screen shows. */
const resolvedSeverity = (profile: StandardsProfile) =>
  Object.fromEntries(STANDARDS_RULE_IDS.map((rule) => [rule, ruleSeverity(profile, rule)]));

/** Where a project stands on standards: the gate's answer and the rail badge's. */
export type StandardsState = 'approved' | 'pending' | 'rejected' | 'none';

/** `POST /api/projects` body: a source union the generic `obj` cannot express. */
const createProjectV: Validator<ProjectIntakeInput> = (v, field) => {
  const base = obj({
    name: str(1, 80),
    source: (s) => s,
    stack: stackV,
    defaultEngine: engineIdV,
    versionBudgetUsd: opt(num(0, 100000)),
  })(v, field);
  const src = base.source;
  let source: ProjectIntakeInput['source'];
  if (src && typeof src === 'object' && (src as { kind?: unknown }).kind === 'path') {
    const s = obj({ kind: oneOf(['path'] as const), path: str(1, 1024) })(src, 'source');
    source = { kind: 'path', path: s.path };
  } else if (src && typeof src === 'object' && (src as { kind?: unknown }).kind === 'clone') {
    const c = obj({ kind: oneOf(['clone'] as const), url: str(1, 2048), dirName: str(1, 64) })(src, 'source');
    source = { kind: 'clone', url: c.url, dirName: c.dirName };
  } else {
    throw new ValidationError('source.kind', 'expected "path" or "clone"');
  }
  return {
    name: base.name, source, stack: base.stack, defaultEngine: base.defaultEngine,
    ...(base.versionBudgetUsd !== undefined ? { versionBudgetUsd: base.versionBudgetUsd } : {}),
  };
};

// ─── App ───

export function createApp(deps: AppDeps): App {
  const { config, users, sessions, audit, projects, state, limiter } = deps;
  const verify = deps.verifyPassword ?? realVerifyPassword;
  const scryptSaturated = deps.scryptSaturated ?? isScryptSaturated;
  const passwordLimiter = deps.passwordLimiter ?? new LoginRateLimiter();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => process.stderr.write(`[moag-server] ${m}\n`));
  const secure = config.secureCookies;
  const sseCounts = new Map<string, number>();
  const staticServer = createStaticServer({ root: deps.webRoot });
  const secrets = deps.secrets ?? new SecretStore(config.dataDir, config.masterKey);
  const engineCache = new EngineStatusCache(now);
  const keyStatus = (e: EngineId) => secrets.status(e);
  const engineAvailable = deps.engineAvailable ?? ((e: EngineId) => engineCache.isAvailable(e, keyStatus));
  const outcomes = deps.outcomes ?? new OutcomeStore(config.dataDir, log);
  const settings = deps.settings ?? new ServerSettingsStore(config.dataDir);
  const standards = deps.standards ?? new StandardsStore(config.dataDir);

  /** Per run-segment job: what an outcome needs that the worker event does not carry. */
  interface RunJobContext {
    runId: string;
    stack: StackId;
    /** taskId → declared type and statically resolved engine (task → playlist → plan → project). */
    tasks: Map<string, { type: TaskType; engine: EngineId }>;
    fallbackEngine: EngineId;
  }
  const runJobContexts = new Map<string, RunJobContext>();

  const jobs = new JobManager({
    dataDir: config.dataDir,
    spawnWorker: deps.spawnWorker,
    maxConcurrent: config.maxConcurrentJobs,
    runsDisabledReason: config.runsDisabledReason,
    killProcess: deps.killProcess,
    workerLeadsProcessGroup: deps.workerLeadsProcessGroup,
    ...(deps.isPidAlive ? { isPidAlive: deps.isPidAlive } : {}),
    recordSpend: (projectId, key, usd) => {
      state.update(projectId, (s) => { s.versionSpend[key] = (s.versionSpend[key] ?? 0) + usd; });
    },
    // Stack evidence: one record per terminal task of a server run, stack frozen at run start.
    onTaskOutcome: (o) => {
      const c = runJobContexts.get(o.jobId);
      if (!c) { return; }
      const t = c.tasks.get(o.taskId);
      const engine = (o.engine && (ENGINE_IDS as readonly string[]).includes(o.engine) ? o.engine as EngineId : null) ?? t?.engine ?? c.fallbackEngine;
      outcomes.append({
        kind: 'task', ts: now().toISOString(), projectId: o.projectId, runId: c.runId, stack: c.stack,
        engine, taskType: t?.type ?? 'agent', status: o.status,
      });
    },
    log,
  });

  // ─── Helpers ───

  const actorOf = (u: UserRecord): Actor => ({ id: u.id, roles: u.roles });

  const writeAudit = (ctx: Ctx, entry: Omit<AuditInput, 'actorUserId' | 'actorUsername' | 'ip'> & { actor?: UserRecord }): void => {
    const actor = entry.actor ?? ctx.user;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { actor: _a, ...rest } = entry;
    audit.append({ actorUserId: actor?.id ?? '', actorUsername: actor?.username ?? '', ip: ctx.ip, ...rest });
  };

  const getProject = (id: string): ProjectRecord => {
    const p = projects.get(id);
    if (!p) { throw new HttpError(404, 'not-found', 'Project not found.'); }
    return p;
  };

  const latestVersion = (plan: Plan) => {
    const v = plan.prdVersions ?? [];
    return v.length > 0 ? v[v.length - 1] : undefined;
  };

  const spendFor = (project: ProjectRecord, st: ProjectState, versionCreatedAt: string | undefined) => {
    const spent = versionCreatedAt ? (st.versionSpend[versionCreatedAt] ?? 0) : 0;
    const cap = project.versionBudgetUsd;
    return { versionCreatedAt: versionCreatedAt ?? null, spentUsd: spent, capUsd: cap, noCap: cap === 0, remainingUsd: cap === 0 ? null : Math.max(0, cap - spent) };
  };

  const requireBudget = (project: ProjectRecord, st: ProjectState, key: string): number => {
    if (project.versionBudgetUsd === 0) { return 0; }
    const remaining = project.versionBudgetUsd - (st.versionSpend[key] ?? 0);
    if (!(remaining > 0)) { throw new HttpError(409, 'budget-exhausted', 'The cost cap for this PRD version is used up. Raise the cap to continue.'); }
    return remaining;
  };

  const requireRunsEnabled = (): void => {
    if (config.runsDisabledReason !== null) {
      throw new HttpError(409, 'runs-disabled', 'Runs are disabled: the server sets CI=true, which would auto-approve ship gates.');
    }
  };

  /** Re-check the workspace at job start: it must still resolve inside the projects root (symlink TOCTOU). */
  const requireWorkspace = (project: ProjectRecord): string => {
    try {
      const real = fs.realpathSync.native(project.workspacePath);
      const root = fs.realpathSync.native(config.projectsRoot);
      if (real === root || !isPathInside(root, real) || !fs.statSync(real).isDirectory()) { throw new Error('escape'); }
      return real;
    } catch {
      throw new HttpError(409, 'workspace-invalid', 'The project workspace is missing or no longer inside the projects root.');
    }
  };

  const requireEngine = (engine: EngineId): void => {
    if (SERVER_FORBIDDEN_ENGINES.includes(engine)) {
      throw new HttpError(400, 'engine-not-supported', `${engine} is not supported in the web app.`);
    }
    if (engineAvailable(engine) === false) {
      throw new HttpError(409, 'engine-unavailable', `${engine} isn't installed on this server, so this can't start.`);
    }
  };

  /** The approval covered one engine: a run (or a resumed segment) never starts on another. */
  const requireApprovedEngine = (project: ProjectRecord, review: PlanReview): void => {
    const approved = lockedEngine(review);
    if (approved !== project.defaultEngine) {
      throw new HttpError(409, 'engine-changed',
        `This plan was approved to run on ${approved}, but the project now uses ${project.defaultEngine}. Switch the project back or request a new plan.`,
        { approvedEngine: approved });
    }
  };

  /** {@link requireEngine} for every engine a plan can run on (default, fallback, playlist, task, consensus). */
  const requirePlanEngines = (plan: Plan): void => {
    for (const e of referencedEngines(plan)) { requireEngine(e); }
  };

  /**
   * Refuse a plan whose playlist does not pass {@link validatePendingPlaylist}
   * NOW. The review stored with the plan is only what the rules said when it was
   * generated; a plan that was pending or approved before a rule existed (the
   * `parallel` refusal, the `cwd` check) must still be refused by it. `also` is
   * any other copy of the playlist that would run (the canonical one at run start).
   * Stored errors are kept too: a redacted credential cannot be re-derived.
   * 409 `engine-not-allowed` when every error is about a disallowed engine,
   * 409 `review-errors` otherwise; `lead` prefixes the message.
   */
  const requireReviewPasses = (review: PlanReview, also: readonly PlanFilePlaylist[] = [], lead = ''): void => {
    const errors = new Set<string>(review.review && !review.review.ok ? review.review.errors : []);
    const engineErrors = new Set<string>();
    for (const pl of [review.playlist, ...also]) {
      if (!pl) { continue; }
      for (const e of validatePendingPlaylist(pl, SERVER_ENGINES).errors) { errors.add(e); }
      for (const e of pendingPlaylistEngineErrors(pl, SERVER_ENGINES)) { engineErrors.add(e); }
    }
    const list = [...errors];
    if (list.length === 0) {
      if (!review.review || review.review.ok) { return; }
      list.push('This plan did not pass review.');
    }
    const code = list.every((e) => engineErrors.has(e)) ? 'engine-not-allowed' : 'review-errors';
    throw new HttpError(409, code, `${lead}${list.join(' ')}`, { errors: list });
  };

  /** True when any engine the plan references is known to be missing (the DTO mirror of {@link requirePlanEngines}). */
  const planEngineUnavailable = (plan: Plan): boolean =>
    [...referencedEngines(plan)].some((e) => SERVER_FORBIDDEN_ENGINES.includes(e) || engineAvailable(e) === false);

  /** `kind: 'plan'` turns every engine's auto-approve off (plan generation is PO-triggered; see buildPlanWorkerConfig). */
  const writeWorkerConfig = (dir: string, project: ProjectRecord, remaining: number, kind: 'run' | 'plan' = 'run'): string => {
    const configPath = path.join(dir, 'config.json');
    const doc = kind === 'plan'
      ? buildPlanWorkerConfig(project, remaining, config.maxUsdPerEngineCall)
      : buildWorkerConfig(project, remaining, config.maxUsdPerEngineCall);
    writeFileAtomicSync(configPath, JSON.stringify(doc, null, 2), 0o600);
    return configPath;
  };

  /**
   * A worker env carrying only the credentials of `engines` (the job's plan's
   * referenced engines ∩ KEYED_ENGINE_ENV), plus the values to redact from
   * anything the worker reports back.
   */
  const workerEnv = (configPath: string, engines: Iterable<EngineId>): { env: NodeJS.ProcessEnv; redact: string[] } => {
    const engineCredentials = secrets.decryptFor(engines);
    return {
      env: buildWorkerEnv(deps.serverEnv, { passthrough: config.runEnvPassthrough, engineCredentials, configPath }),
      redact: Object.values(engineCredentials),
    };
  };

  const usernameOf = (id: string | undefined): string | null => (id ? users.findById(id)?.username ?? null : null);

  /** What can stop a run from starting right now, beyond role and plan status (shared by DTOs and the run guard). */
  interface StartContext {
    jobActive: boolean; runsDisabled: boolean; budgetExhausted: boolean; engineUnavailable: boolean; engineChanged: boolean;
    /** False only when the plan was generated under standards and the store now has no approved version. */
    standardsApproved: boolean;
  }
  /** The engine a reviewer approved the plan under (legacy approvals: the engine it was generated with). */
  const lockedEngine = (review: PlanReview): EngineId => review.approvedEngine ?? review.engine;
  const startContext = (project: ProjectRecord, st: ProjectState, review: PlanReview, canonical: Plan): StartContext => ({
    jobActive: jobs.isActive(project.id) || st.runs.some((r) => r.status === 'running'),
    runsDisabled: config.runsDisabledReason !== null,
    budgetExhausted: project.versionBudgetUsd > 0 && !(project.versionBudgetUsd - (st.versionSpend[review.forVersionCreatedAt] ?? 0) > 0),
    engineUnavailable: planEngineUnavailable(canonical),
    engineChanged: (review.status === 'approved' || review.status === 'ran') && lockedEngine(review) !== project.defaultEngine,
    standardsApproved: !standardsLost(project, review),
  });
  const startBlockedReason = (c: StartContext): string | null =>
    c.runsDisabled ? 'runs-disabled' : c.jobActive ? 'job-active' : c.engineChanged ? 'engine-changed'
      : c.engineUnavailable ? 'engine-unavailable' : !c.standardsApproved ? 'standards-not-approved'
        : c.budgetExhausted ? 'budget-exhausted' : null;

  /** Plan review DTO. `start` (when given) adds `run.start` for approved plans and why it is blocked. */
  const planDto = (p: PlanReview, u: UserRecord, start?: StartContext) => ({
    ...p,
    requestedByName: usernameOf(p.requestedBy),
    decidedByName: usernameOf(p.decidedBy),
    ...(start && (p.status === 'approved' || p.status === 'ran') ? { startBlockedReason: startBlockedReason(start) } : {}),
    allowedActions: allowedActions(actorOf(u), start ? ['plan.approve', 'plan.reject', 'plan.cancel', 'run.start'] : ['plan.approve', 'plan.reject', 'plan.cancel'], {
      planStatus: p.status, requestedBy: p.requestedBy, ...(start ?? {}),
    }),
  });

  const runDto = (r: RunRecord, u: UserRecord, project: ProjectRecord, st: ProjectState) => {
    const live = r.status === 'running' ? jobs.view(project.id) : null;
    // A resumed segment's live view covers only its own tasks: layer it over the record.
    const view = live ? mergeRunViews(r.view, live) : r.view;
    return {
      ...r,
      view,
      startedByName: usernameOf(r.startedBy),
      stoppedByName: usernameOf(r.stoppedBy),
      gateDecisions: (r.gateDecisions ?? []).map((d) => ({ ...d, byName: usernameOf(d.by) })),
      cost: spendFor(project, st, r.versionCreatedAt),
      allowedActions: allowedActions(actorOf(u), ['run.stop', 'gate.approve', 'gate.reject', 'gate.skip'], {
        runnerState: r.status === 'running' ? (view?.runnerState ?? 'playing') : 'idle',
        runStatus: r.status,
      }),
    };
  };

  /** The run's tasks (from its plan snapshot) with live statuses, error tails, recent events and the gate's dependents. */
  const runDetail = (project: ProjectRecord, st: ProjectState, r: RunRecord) => {
    const dir = state.runDir(project.id, r.id);
    const review = st.plans.find((x) => x.id === r.planId);
    let tasks: Array<{ id: string; name: string; type: string; engine: string | null; status: string; requirementIds: string[] }> = [];
    let playlistName: string | null = null;
    let afterGate: string[] = [];
    // Read events first: a task's `task-engine` event is the engine that actually ran it.
    const errorTails: Record<string, string> = {};
    const ranEngines: Record<string, string> = {};
    const events: unknown[] = [];
    try {
      const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { event?: string; id?: string; tail?: string; engine?: string };
          if (ev.event === 'task-error-tail' && typeof ev.id === 'string' && typeof ev.tail === 'string') { errorTails[ev.id] = ev.tail.slice(-4000); }
          if (ev.event === 'task-engine' && typeof ev.id === 'string' && typeof ev.engine === 'string') { ranEngines[ev.id] = ev.engine; }
        } catch { /* skip a torn line */ }
      }
      for (const line of lines.slice(-RUN_DETAIL_EVENTS)) {
        try { events.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* no events yet */ }
    try {
      const snap = loadPlan(path.join(dir, 'plan.json'));
      const pl = snap.playlists[review?.playlistIndex ?? 0];
      if (pl) {
        playlistName = pl.name;
        const live = r.status === 'running' ? jobs.view(project.id) : null;
        const liveTasks = (live ? mergeRunViews(r.view, live) : r.view)?.tasks ?? {};
        tasks = pl.tasks.map((t) => ({
          id: t.id, name: t.name, type: t.type ?? 'agent',
          // What ran (task-engine event), else what the runner WILL resolve from this snapshot.
          engine: ranEngines[t.id] ?? t.engine ?? pl.engine ?? snap.defaultEngine,
          status: liveTasks[t.id] ?? t.status, requirementIds: t.requirementIds ?? [],
        }));
        if (r.gate) {
          // Everything that (transitively) depends on the gate runs only after approval.
          const blocked = new Set<string>([r.gate.taskId]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const t of pl.tasks) {
              if (!blocked.has(t.id) && (t.dependsOn ?? []).some((d) => blocked.has(d))) { blocked.add(t.id); grew = true; }
            }
          }
          afterGate = pl.tasks.filter((t) => t.id !== r.gate!.taskId && blocked.has(t.id)).map((t) => t.name);
        }
      }
    } catch { /* snapshot missing or unreadable: show the record only */ }
    // The standards report as the worker last sent it. Absent — not empty — for a run that
    // has none (a legacy plan, or a run that ended before any check): "no report" is not a pass.
    const standardsReport = readStandardsReport(dir);
    return { runId: r.id, playlistName, tasks, errorTails, events, afterGate, ...(standardsReport ? { standardsReport } : {}) };
  };

  // ─── Project standards ───

  interface StandardsView {
    migrated: boolean;
    /** Shared with the store's cache: read-only. */
    versions: readonly StandardsVersionRecord[];
    /** The latest approved version: what plans and runs are held to. */
    effective: StandardsVersionRecord | null;
    pending: StandardsVersionRecord | null;
    state: StandardsState;
  }

  /**
   * A project's standards as the gates and DTOs see them. A store that cannot be
   * read counts as "nothing approved": the plan gate stays closed (fail closed)
   * and the project list still loads.
   */
  const standardsView = (projectId: string): StandardsView => {
    try {
      const { migrated, versions } = standards.load(projectId);
      const approved = versions.filter((v) => v.status === 'approved');
      const effective = approved.length > 0 ? approved[approved.length - 1] : null;
      const pending = versions.find((v) => v.status === 'pending') ?? null;
      const last = versions.length > 0 ? versions[versions.length - 1] : null;
      const state: StandardsState = effective ? 'approved' : pending ? 'pending' : last?.status === 'rejected' ? 'rejected' : 'none';
      return { migrated, versions, effective, pending, state };
    } catch (err) {
      log(`standards ${projectId}: ${(err as Error).message}`);
      return { migrated: false, versions: [], effective: null, pending: null, state: 'none' };
    }
  };

  /** A store refusal as the HTTP error the client is told about. */
  const standardsRefusal = (err: unknown): unknown => {
    if (!(err instanceof StandardsStoreError)) { return err; }
    const status = err.code === 'invalid-standards' ? 400 : err.code === 'not-found' ? 404 : 409;
    return new HttpError(status, err.code, err.message, err.details);
  };

  const standardsDto = (p: ProjectRecord, u: UserRecord) => {
    const view = standardsView(p.id);
    const actor = actorOf(u);
    const current = view.effective ?? view.pending;
    return {
      migrated: view.migrated,
      state: view.state,
      effectiveVersion: view.effective?.version ?? null,
      pendingVersion: view.pending?.version ?? null,
      stack: p.stack,
      // The profile was proposed for another stack than the project has now (changing the stack proposes nothing).
      stackMismatch: !!current && current.profile.stackTemplateId !== p.stack,
      versions: view.versions.map((v) => {
        // A version is compared with the one in effect while it is (or was) under review —
        // what approving it replaces — never with its immediate base, which may be a
        // proposal nobody approved. Only while nothing is in effect at all is the base the
        // reference for the section markers; severities are then measured against the defaults.
        const reference = inEffectBefore(view.versions, v);
        const base = reference ?? (v.baseVersion === null ? undefined : view.versions.find((x) => x.version === v.baseVersion));
        // The same comparison the audit log and the approval check make (`enforcementReview`):
        // one function, so the diff shown, the acknowledgement required and the audit flag
        // can never disagree.
        const review = enforcementReview(view.versions, v);
        return {
          ...v,
          inEffect: v.version === view.effective?.version,
          // Verbatim, exactly as a worker would run them: approving the version approves these.
          commands: v.profile.commands.map((c) => ({ label: c.label, run: c.run })),
          // Which rules stop a release under this version, and which only report.
          severity: resolvedSeverity(v.profile),
          // What this version promotes or demotes relative to what is in effect (`severityComparedTo`),
          // or to the defaults when nothing is (null) — whatever it was proposed on top of.
          severityChanged: review.severity,
          severityComparedTo: review.comparedTo,
          // Every difference from what is in force in a field that decides what can stop a
          // release — commands, severities, required directories — with before and after.
          // Shown un-collapsed on the review screen; while `changed`, an approval must carry
          // this version's content hash as `acknowledgedEnforcementHash`.
          enforcementChanged: {
            comparedTo: review.comparedTo, changed: review.changed, fields: review.fields,
            commands: review.commands, severity: review.severity, requiredDirs: review.requiredDirs, ruleConfig: review.ruleConfig,
          },
          proposedByName: v.proposedBy === SYSTEM_ACTOR ? null : usernameOf(v.proposedBy),
          decidedByName: usernameOf(v.decidedBy),
          changedFrom: base
            ? { version: base.version, sections: STANDARDS_SECTIONS.filter((k) => JSON.stringify(v.profile[k]) !== JSON.stringify(base.profile[k])) }
            : null,
          allowedActions: allowedActions(actor, ['standards.approve', 'standards.reject', 'standards.accept-defaults'], {
            standardsStatus: v.status,
            standardsAcceptable: view.migrated && v.status === 'pending' && v.origin === 'auto',
          }),
        };
      }),
      limits: {
        freeTextChars: MAX_STANDARDS_FREE_TEXT_CHARS, commands: MAX_STANDARDS_COMMANDS,
        commandChars: MAX_STANDARDS_COMMAND_CHARS, versions: MAX_STANDARDS_VERSIONS,
      },
      // What each rule is when a profile says nothing about it.
      severityDefaults: { ...DEFAULT_RULE_SEVERITY },
      // The rules MOAG decides by scanning text itself. The editor warns before one is made
      // blocking: a heuristic can stop correct code and can miss a violation.
      scannerRules: STANDARDS_RULE_IDS.filter((rule) => isScannerRule(rule)),
      allowedActions: allowedActions(actor, ['standards.propose']),
    };
  };

  /**
   * The approved standards a new plan must be generated under, or 409
   * `standards-not-approved` with where the project stands. Like
   * {@link requireReviewPasses}, this is evaluated NOW at every step that calls
   * it — plan generation, plan approval — never read from what an earlier step stored.
   */
  const requireStandards = (project: ProjectRecord): StandardsVersionRecord => {
    const view = standardsView(project.id);
    if (view.effective) { return view.effective; }
    const why = view.state === 'pending' ? `Standards v${view.pending!.version} is waiting for a reviewer.`
      : view.state === 'rejected' ? 'The proposed standards were rejected; edit them and submit again.'
        : 'No standards have been approved.';
    throw new HttpError(409, 'standards-not-approved', `This project has no approved standards, so this can't continue. ${why}`,
      { state: view.state, pendingVersion: view.pending?.version ?? null });
  };

  /**
   * True when a plan generated under standards can no longer be held to any:
   * the store has no approved version (lost or tampered with). Approved versions
   * are immutable, so this never happens in normal use; a run then refuses to
   * start. A legacy plan that never carried a standards version is not affected.
   */
  const standardsLost = (project: ProjectRecord, review: PlanReview): boolean =>
    review.standardsVersion !== undefined && standardsView(project.id).effective === null;

  /**
   * The ref a new run's standards check diffs against: everything the project has
   * not shipped yet.
   *
   * HEAD at run start is the wrong base. An agent that commits its work (or a run
   * left at the ship gate whose work is committed by hand) moves HEAD past that
   * work, and the next run would then diff from after it — a violation committed
   * between runs would be forgiven for good and its requirement stamped shipped.
   * So the base is the ref the project last shipped at; before the first ship, the
   * base of its earliest run; and only for the very first run, HEAD as it stands.
   */
  const standardsBaseRef = async (st: ProjectState, workspace: string): Promise<string | null> => {
    // A ship recorded without a ref (written by an earlier build when HEAD could not be read)
    // is no base at all: fall through to the next best one instead of returning null for good.
    if (st.lastShipped?.ref) { return st.lastShipped.ref; }
    const earliest = st.runs.find((r) => r.baseRef !== undefined);
    if (earliest) { return earliest.baseRef ?? null; }
    return gitHead(workspace, deps.exec);
  };

  /**
   * Write the standards job file a worker reads: the approved version, frozen,
   * with the prompt and planner text rendered HERE — the worker never renders,
   * infers a command, or reads a standards file from the repository.
   */
  const writeStandardsJobFile = (dir: string, v: StandardsVersionRecord, baseRef: string | null): string => {
    const file = path.join(dir, 'standards.json');
    const doc: StandardsJobFile = {
      schemaVersion: 1, version: v.version, contentHash: v.contentHash, baseRef, profile: v.profile,
      promptText: renderStandardsText(v.profile, v.version),
      plannerText: renderPlannerStandards(v.profile, v.version),
    };
    writeFileAtomicSync(file, JSON.stringify(doc, null, 2), 0o600);
    return file;
  };

  /**
   * The provenance of a version a PERSON proposes.
   *
   * A `detected` tag is a statement the server made about a value it read from the
   * repository, and the approval screen shows it beside commands that will run on
   * the server. So a tag survives an edit only for an area whose content is still
   * exactly what the server proposed: each area is compared with the last automatic
   * version the proposal descends from — not with its immediate base, which may
   * itself be a person's edit. Every area that differs is tagged `assumed`,
   * "entered by <proposer>". With no automatic ancestor, every area is.
   */
  const userProvenance = (projectId: string, profile: StandardsProfile, baseVersion: number | null, proposer: string): StandardsProvenance => {
    const versions = standards.load(projectId).versions;
    const byNumber = (n: number | null): StandardsVersionRecord | undefined => (n === null ? undefined : versions.find((v) => v.version === n));
    let auto = byNumber(baseVersion);
    // Version numbers only fall along the chain, so this ends; the bound is belt and braces.
    for (let steps = 0; auto && auto.origin !== 'auto' && steps <= versions.length; steps++) { auto = byNumber(auto.baseVersion); }
    if (auto && auto.origin !== 'auto') { auto = undefined; }
    const at = (source: unknown, field: ProvenanceField): unknown =>
      field.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), source);
    const entered = { tag: 'assumed' as const, evidence: `entered by ${proposer}` };
    const provenance = {} as StandardsProvenance;
    for (const field of PROVENANCE_FIELDS) {
      const untouched = !!auto && auto.provenance?.[field] !== undefined && isDeepStrictEqual(at(profile, field), at(auto.profile, field));
      provenance[field] = untouched ? { ...auto!.provenance[field] } : { ...entered };
    }
    return provenance;
  };

  /** The audit payload of every standards mutation: identity only, never profile text. */
  const standardsAudit = (v: StandardsVersionRecord) => ({ version: v.version, contentHash: v.contentHash, origin: v.origin });

  /**
   * What `v` changes about enforcement relative to the standards in effect — if `v` is
   * approved (at propose time), or when it just has been (at approve time): any difference in
   * the commands (a label, a command line, the order), in a rule's severity, in the required
   * directories, or in the configuration of a rule that is blocking. Flagged `enforcement-changed`, with what each differing field held
   * before and after; no attempt is made to call a change a tightening or a loosening.
   * Measured against the latest approved version other than `v` — never against
   * `v.baseVersion`, which may be a superseded proposal that already carried the change — and
   * against an empty baseline when nothing is approved, so a first version is recorded too.
   * The values are profile text a reviewer approved to run or to require (already refused if
   * credential-shaped), and exactly what an auditor needs: they decide what can stop a release.
   *
   * A store that cannot be read fails closed (`standardsChangeAudit`): the entry is flagged as
   * an enforcement change that could not be verified, never left unflagged.
   *
   * Returns the audit `after` and `flags` of a propose, approve or accept-defaults.
   */
  const standardsAuditWithSeverity = (projectId: string, v: StandardsVersionRecord, flags: string[] = []) => {
    const change = standardsChangeAudit(standards, projectId, v);
    const all = [...flags, ...change.flags];
    return {
      after: { ...standardsAudit(v), ...change.after },
      ...(all.length > 0 ? { flags: all } : {}),
    };
  };

  const projectDto = (p: ProjectRecord, u: UserRecord) => {
    const view = standardsView(p.id);
    return { ...projectFields(p, u), standards: { effectiveVersion: view.effective?.version ?? null, pendingVersion: view.pending?.version ?? null, state: view.state } };
  };

  const projectFields = (p: ProjectRecord, u: UserRecord) => ({
    id: p.id,
    name: p.name,
    workspaceName: path.basename(p.workspacePath),
    source: p.source,
    stack: p.stack,
    defaultEngine: p.defaultEngine,
    versionBudgetUsd: p.versionBudgetUsd,
    createdAt: p.createdAt,
    createdBy: p.createdBy,
    allowedActions: allowedActions(actorOf(u), ['project.update', 'prd.save', 'plan.generate', 'run.start']),
  });

  const STANDARDS_REPORT_FILE = 'standards-report.json';

  /** What the latest `verify-standards` line of a run's live segment said it checked against. */
  interface StandardsAttestation {
    phase: StandardsReportPhase;
    version: number | null;
    /** sha256 of the profile the worker actually checked with; null when it sent none. */
    contentHash: string | null;
    /** The base ref the worker was told to diff against; undefined when it sent none. */
    recordedBaseRef: string | null | undefined;
    /**
     * Where the blocking set of the frozen profile stands in the report: `evaluated`,
     * `none-configured` (nothing can stop a release: it ships, stamped as such) or
     * `not-checked` (a command never ran, or a promoted rule could not decide: nothing ships).
     */
    blockingState: BlockingSetState;
    failed: number;
    /** What the check left open — recorded on the release stamp beside the version. */
    counts: StandardsCheckCounts;
  }
  /** Per run, for the segment in flight only: cleared when a segment starts and when it ends. */
  const standardsAttestations = new Map<string, StandardsAttestation>();

  /**
   * Why a run that exited 0 must NOT be taken as checked against its standards, or
   * null when it was.
   *
   * The worker re-reads its standards job file after the agent has run, and that file
   * sits in the agent-writable run dir: a rewrite that empties the profile or moves the
   * base ref to the current HEAD, with the hash updated to match, is self-consistent and
   * the worker cannot tell. The server can: the version, hash and base ref it froze on
   * the run record never left the data dir's state file, and the worker reports what it
   * really used on its own pipe.
   */
  const standardsCheckProblem = (rec: RunRecord, seen: StandardsAttestation | undefined): string | null => {
    if (rec.standardsVersion === undefined) { return null; }
    if (!seen || seen.phase !== 'verify') {
      return 'the verification pass sent no standards report';
    }
    if (seen.version !== rec.standardsVersion || seen.contentHash !== rec.standardsHash) {
      return `the standards check was not made against the approved standards v${rec.standardsVersion}`;
    }
    if (seen.recordedBaseRef !== (rec.baseRef ?? null)) {
      return 'the standards check was not made against the base recorded for this run';
    }
    // `failed` counts blocking rules and commands only: an advisory finding never stops a ship.
    if (seen.failed > 0) {
      return 'the standards report lists a failed blocking rule';
    }
    // Unevaluated blocking evidence is not a pass.
    if (seen.blockingState === 'not-checked') {
      return 'the standards report lists a blocking rule or command that was not checked';
    }
    return null;
  };

  /** The run's stored standards report, re-validated on the way out; null when there is none. */
  const readStandardsReport = (dir: string): { phase: StandardsReportPhase; at: string; report: StandardsReport } | null => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, STANDARDS_REPORT_FILE), 'utf-8')) as { phase?: unknown; at?: unknown; report?: unknown };
      const report = parseStandardsReport(doc.report);
      if (!report) { return null; }
      return { phase: doc.phase === 'pre-gate' ? 'pre-gate' : 'verify', at: typeof doc.at === 'string' ? doc.at : '', report };
    } catch {
      return null;
    }
  };

  /**
   * Keep a worker's `verify-standards` payload: shape-checked and bounded by
   * `parseStandardsReport` (its strings were already redacted with the job's
   * credentials by the job manager), written to the run dir — never to
   * state.json — with only the totals on the run record. A payload that does
   * not parse is dropped; nothing here throws into the event pipeline.
   */
  const recordStandardsReport = (projectId: string, runId: string, dir: string, data: Record<string, unknown>): void => {
    const parsed = parseStandardsReport(data);
    if (!parsed) { log(`run ${runId}: malformed standards report dropped`); return; }
    // What blocks is decided by the profile the SERVER froze on the run, never by what the
    // worker's report says about itself: a row cannot arrive demoted to advisory.
    let report = parsed;
    try {
      const rec = state.load(projectId).runs.find((x) => x.id === runId);
      const frozen = rec?.standardsVersion !== undefined ? standards.get(projectId, rec.standardsVersion) : null;
      report = applyProfileSeverity(parsed, frozen ? frozen.profile : null);
      // Likewise WHICH commands must have a result is decided by the frozen profile. A command
      // the report says nothing about was not evaluated: it is added as not checked, so a
      // report that merely leaves a command out can never read as "nothing blocking".
      const unreported = (frozen ? frozen.profile.commands : [])
        .filter((c) => !report.rules.some((r) => r.rule === 'command' && r.command === c.run));
      if (unreported.length > 0) {
        report = {
          ...report,
          rules: [...report.rules, ...unreported.map((c) => commandRow({ result: 'not-checked', reason: 'The report holds no result for this command', command: c.run }))],
        };
        report.totals = recountTotals(report);
      }
    } catch (err) {
      log(`run ${runId}: standards severity could not be re-derived, every rule is taken as blocking: ${(err as Error).message}`);
      report = applyProfileSeverity(parsed, null);
    }
    const phase: StandardsReportPhase = data.phase === 'pre-gate' ? 'pre-gate' : 'verify';
    const at = now().toISOString();
    // Kept in memory, straight from the worker's pipe: what the check says it was made
    // against. The copy in the run dir is for display only — the run dir is agent-writable.
    standardsAttestations.set(runId, {
      phase,
      version: report.version,
      contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
      recordedBaseRef: data.recordedBaseRef === null ? null : typeof data.recordedBaseRef === 'string' ? data.recordedBaseRef : undefined,
      blockingState: standardsBlockingState(report),
      failed: report.totals.failed,
      counts: standardsCheckCounts(report),
    });
    try {
      writeFileAtomicSync(path.join(dir, STANDARDS_REPORT_FILE), JSON.stringify({ phase, at, report }, null, 2), 0o600);
    } catch (err) {
      log(`run ${runId}: standards report not saved: ${(err as Error).message}`);
      return;
    }
    void state.withProjectLock(projectId, () => {
      state.update(projectId, (s) => {
        const r = s.runs.find((x) => x.id === runId);
        if (r) { r.standardsSummary = { phase, version: report.version, ...report.totals, at }; }
      });
    }).catch((err) => log(`run ${runId}: standards summary not saved: ${(err as Error).message}`));
  };

  const appendRunEvent = (dir: string, ev: WorkerEvent): void => {
    try {
      const file = path.join(dir, 'events.jsonl');
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size < MAX_RUN_EVENTS_BYTES) {
        fs.appendFileSync(file, JSON.stringify({ ts: now().toISOString(), ...ev }) + '\n', { mode: 0o600 });
      }
    } catch (err) { log(`events.jsonl: ${(err as Error).message}`); }
  };

  // ─── Job lifecycle ───

  /**
   * Settle a plan review from the worker's outcome file. `redact` is the job's
   * injected credentials: outcome errors carry engine output, so they are
   * redacted exactly like a run's error tails before they reach state.json or a DTO.
   */
  const onPlanEnd = (projectId: string, planId: string, outPath: string, redact: readonly string[] = []) => (end: JobEnd): void => {
    const safeError = (text: unknown): string => redactSecrets(String(text ?? ''), redact).slice(0, 4000);
    void state.withProjectLock(projectId, () => {
      let doc: { kind?: string; error?: string; rejected?: PlanReview['rejected']; playlist?: PlanFilePlaylist } | null = null;
      try { doc = JSON.parse(fs.readFileSync(outPath, 'utf-8')); } catch { doc = null; }
      // The playlist and rejections are model output every signed-in user reads,
      // produced by an engine whose env held `redact`: scrub every string before
      // anything is stripped, hashed, stored or shown.
      const leaked = doc && typeof doc === 'object'
        ? redactStringsDeep(doc.playlist, (t) => redactSecrets(t, redact)) + redactStringsDeep(doc.rejected, (t) => redactSecrets(t, redact))
        : 0;
      state.update(projectId, (s) => {
        const p = s.plans.find((x) => x.id === planId);
        if (!p || p.status !== 'generating') { return; }
        if (end.status === 'stopped') { p.status = 'cancelled'; return; }
        if (!doc || end.exitCode !== 0) {
          p.status = 'engine-failed';
          p.error = safeError(doc?.error ?? 'Plan generation did not complete.');
          return;
        }
        switch (doc.kind) {
          case 'no-delta': p.status = 'no-delta'; break;
          case 'engine-failed': p.status = 'engine-failed'; p.error = safeError(doc.error); break;
          case 'parse-failed': p.status = 'parse-failed'; p.error = safeError(doc.error); break;
          case 'all-rejected': p.status = 'all-rejected'; p.rejected = doc.rejected ?? []; break;
          case 'appended': {
            const pl = doc.playlist;
            if (!pl || typeof pl !== 'object' || !Array.isArray(pl.tasks)) {
              p.status = 'parse-failed';
              p.error = 'The generated playlist was malformed.';
              break;
            }
            // A generated task must never arrive pre-completed: a playlist whose
            // ship-gate task said "completed" would let the runner skip the gate.
            for (const t of pl.tasks) { delete t.status; }
            // Env injection, env-file inheritance and git tag/push are never
            // model-chosen: stripped before hashing, so approval never covers them.
            const stripped = stripGeneratedSideEffects(pl);
            // "Gated at ship": generated plans never contain the gate, so the
            // server appends it — before hashing, so the reviewer sees and
            // approves exactly the gated playlist.
            appendShipGate(pl, `ship-gate-${planId}`);
            p.playlist = pl;
            p.contentHash = contentHash(pl);
            const review = validatePendingPlaylist(pl, SERVER_ENGINES);
            if (leaked > 0) {
              // A credential in model output means the PRD steered the planner: never approvable.
              review.ok = false;
              review.errors.push(CREDENTIAL_IN_PLAYLIST_ERROR);
              log(`plan ${planId}: generated output contained an injected credential (${leaked} string(s) redacted)`);
            }
            p.review = { ...review, ...(stripped.length > 0 ? { stripped } : {}) };
            p.rejected = doc.rejected ?? [];
            p.status = 'pending';
            break;
          }
          default:
            p.status = 'parse-failed';
            p.error = 'Unknown plan outcome.';
        }
      });
    }).catch((err) => log(`plan end ${planId}: ${(err as Error).message}`));
  };

  /**
   * Gate runs the PRD loop recorded in `snapshot`'s requirement trace since
   * `since`, one record per distinct run timestamp (the same gates are written
   * to every requirement they exercised).
   */
  const recordGateOutcomes = (snapshot: Plan, seg: { projectId: string; runId: string; stack: StackId; engine: EngineId; since: string }): void => {
    const runs = new Map<string, boolean>();
    for (const rec of snapshot.requirementTrace ?? []) {
      for (const g of rec.gates ?? []) {
        if (typeof g.at !== 'string' || g.at < seg.since) { continue; }
        const green = g.exitCode === 0 && !g.timedOut;
        runs.set(g.at, (runs.get(g.at) ?? true) && green);
      }
    }
    for (const allGreen of runs.values()) {
      outcomes.append({ kind: 'gate', ts: now().toISOString(), projectId: seg.projectId, runId: seg.runId, stack: seg.stack, engine: seg.engine, gateRun: true, allGreen });
    }
  };

  const onRunEnd = (projectId: string, runId: string, snapshotPath: string, seg: { jobId: () => string | null; stack: StackId; engine: EngineId; since: string }) => (end: JobEnd): void => {
    const jobId = seg.jobId();
    if (jobId) { runJobContexts.delete(jobId); }
    // Taken now, synchronously: the next segment of this run clears it when it starts.
    const attested = standardsAttestations.get(runId);
    standardsAttestations.delete(runId);
    void state.withProjectLock(projectId, async () => {
      const project = projects.get(projectId);
      let shippedAt: string | null = null;
      let standardsProblem: string | null = null;
      if (project) {
        try {
          const canonical = state.loadCanonicalPlan(projectId, project.name, project.defaultEngine);
          const snapshot = loadPlan(snapshotPath);
          // Server-owned ship: generated release tasks carry no tag (stripped),
          // so an approver's approval is what ships. Only a segment that
          // resumed after `approve` and exited 0 (its verify pass ran green)
          // stamps; stampRelease re-checks tasks and gates. A skip never ships.
          //
          // Standards need no branch here. A failed standards gate — a static rule
          // or a profile command — makes the verify pass exit 1, so the segment's
          // status is `gaps` and the `exitCode === 0` test below is false:
          // stampApprovedShip is never reached and nothing is marked shipped, even
          // though the gate was approved and every task completed.
          //
          // What does need one: a segment that exits 0 on a run frozen to a standards
          // version must have PROVED the check — a verify-phase report, made with the
          // frozen profile hash against the frozen base. Without it the run ends `gaps`.
          const rec = state.load(projectId).runs.find((x) => x.id === runId);
          const lastDecision = rec?.gateDecisions?.[rec.gateDecisions.length - 1];
          if (rec && end.status === 'completed' && end.exitCode === 0) {
            standardsProblem = standardsCheckProblem(rec, attested);
            if (standardsProblem) { log(`run ${runId}: ended gaps, nothing shipped: ${standardsProblem}`); }
          }
          if (end.status === 'completed' && end.exitCode === 0 && lastDecision?.action === 'approve' && !standardsProblem) {
            // Release tasks run after the gate: their playlist's release must also have succeeded.
            const playlistIndex = state.load(projectId).plans.find((x) => x.id === rec?.planId)?.playlistIndex;
            // The trace records which standards version the shipped work was checked against.
            // A check in which a blocking rule or command came out not-checked never gets here
            // (`standardsCheckProblem`). One whose profile has no blocking set at all ships, and
            // its stamp says so: the counts carry `noBlockingRules`, shown as "no blocking
            // rules configured" and never as a pass.
            const stampedAt = now().toISOString();
            const stampVersion = attested && attested.blockingState !== 'not-checked' ? rec?.standardsVersion : undefined;
            // Beside the version: how many advisory findings, rules and files the check left open.
            const stampCounts = stampVersion !== undefined ? attested?.counts : undefined;
            const shipped = stampApprovedShip(snapshot, runId, stampedAt, playlistIndex, stampVersion, stampCounts);
            if (shipped.length > 0) {
              writeFileAtomicSync(snapshotPath, JSON.stringify(dehydratePlan(snapshot), null, 2), 0o600);
              shippedAt = stampedAt;
            }
            log(`run ${runId}: approved ship stamped ${shipped.length > 0 ? shipped.join(', ') : 'no requirement'}`);
          }
          mergeRunSnapshot(canonical, snapshot);
          state.saveCanonicalPlan(projectId, canonical, project.defaultEngine);
          recordGateOutcomes(snapshot, { projectId, runId, stack: seg.stack, engine: seg.engine, since: seg.since });
        } catch (err) { log(`run ${runId}: snapshot merge failed: ${(err as Error).message}`); }
      }
      // Only a stamped ship moves the standards base forward: HEAD as it stands now is
      // the last point known to have passed every gate. A run that ended any other way
      // leaves the base alone, so whatever it committed is still inside the next diff.
      const shippedRef = project && shippedAt ? await gitHead(project.workspacePath, deps.exec) : null;
      // A ship whose HEAD could not be read is never stored as the base: a null ref would make
      // every later check diff against the empty tree until the next ship. The previous base
      // stays, so the next diff covers this ship's work again — more is checked, never less.
      if (shippedAt && !shippedRef) { log(`run ${runId}: shipped, but HEAD could not be read; the standards base was not moved`); }
      state.update(projectId, (s) => {
        if (shippedAt && shippedRef) { s.lastShipped = { ref: shippedRef, runId, at: shippedAt }; }
        const r = s.runs.find((x) => x.id === runId);
        if (!r) { return; }
        r.status = end.status as RunStatus;
        r.exitCode = end.exitCode;
        if (standardsProblem) {
          // Exit 0 without proof of the standards check is not a completed run.
          r.status = 'gaps';
          r.exitCode = 1;
          r.errorTail = `Nothing was shipped: ${standardsProblem}.`;
        }
        r.endedAt = now().toISOString();
        // Segments after a gate resume report only their own tasks: keep the earlier statuses and cost.
        r.view = mergeRunViews(r.view, end.view);
        if (end.status === 'awaiting-approval' && end.view.gate) { r.gate = end.view.gate; } else { delete r.gate; }
        if (end.status === 'error') { r.errorTail = (end.spawnError ?? end.stderrTail).slice(-4000); }
      });
    }).catch((err) => log(`run end ${runId}: ${(err as Error).message}`));
  };

  /** Spawn (or resume) a run segment and record its worker pid on `run`. Throws HttpError when the job manager refuses. */
  const spawnRunSegment = (project: ProjectRecord, run: RunRecord, review: PlanReview, remaining: number, workspace: string): void => {
    const dir = state.runDir(project.id, run.id);
    const snapshotPath = path.join(dir, 'plan.json');
    const configPath = writeWorkerConfig(dir, project, remaining);
    const engines = new Set<EngineId>([project.defaultEngine]);
    const tasks = new Map<string, { type: TaskType; engine: EngineId }>();
    try {
      const snap = loadPlan(snapshotPath);
      for (const e of referencedEngines(snap)) { engines.add(e); }
      for (const pl of snap.playlists) {
        for (const t of pl.tasks) {
          tasks.set(t.id, { type: t.type ?? 'agent', engine: t.engine ?? pl.engine ?? snap.defaultEngine ?? project.defaultEngine });
        }
      }
    } catch { /* unreadable snapshot: the worker fails on it; inject nothing extra */ }
    const { env, redact } = workerEnv(configPath, engines);
    // The standards job file is (re)written for every segment from the version RECORDED
    // on the run, never from whatever is latest: a version approved mid-run does not
    // change a run in flight, and the base ref stays the one captured at run start.
    standardsAttestations.delete(run.id);
    let standardsPath: string | undefined;
    if (run.standardsVersion !== undefined) {
      let frozen: StandardsVersionRecord | null = null;
      try { frozen = standards.get(project.id, run.standardsVersion); } catch (err) { log(`standards ${project.id}: ${(err as Error).message}`); }
      if (!frozen || frozen.status !== 'approved' || frozen.contentHash !== run.standardsHash) {
        throw new HttpError(409, 'standards-not-approved',
          `Standards v${run.standardsVersion}, which this run was started under, is no longer available, so the run can't continue.`,
          { state: standardsView(project.id).state, pendingVersion: standardsView(project.id).pending?.version ?? null });
      }
      standardsPath = writeStandardsJobFile(dir, frozen, run.baseRef ?? null);
    }
    const job: RunJob = {
      kind: 'run', runId: run.id, workspace, planPath: snapshotPath,
      startPlaylistIndex: review.playlistIndex ?? 0, verify: true, allowedEngines: SERVER_ENGINES,
      ...(standardsPath ? { standardsPath } : {}),
    };
    let jobId: string | null = null;
    const started = jobs.start({
      projectId: project.id, job, jobPath: path.join(dir, 'job.json'), workspace, env, redact,
      spendKey: run.versionCreatedAt,
      onEvent: (ev) => {
        appendRunEvent(dir, ev);
        if (ev.event === 'verify' && ev.name === 'verify-standards') { recordStandardsReport(project.id, run.id, dir, ev.data); }
      },
      onEnd: onRunEnd(project.id, run.id, snapshotPath, {
        jobId: () => jobId, stack: run.stack, engine: project.defaultEngine, since: now().toISOString(),
      }),
    });
    if (!started.ok) { throw new HttpError(started.status, started.reason, started.message); }
    // Worker output is asynchronous, so the context is in place before its first event.
    jobId = started.jobId;
    if (started.workerPid) { run.workerPid = started.workerPid; } else { delete run.workerPid; }
    runJobContexts.set(started.jobId, { runId: run.id, stack: run.stack, tasks, fallbackEngine: project.defaultEngine });
  };

  // ─── Engine probe ───

  /**
   * Run the existing `--version` probing in a worker (the only vscode-free way
   * to reach it) and cache the result. The probe job carries no credentials and
   * a minimal server-generated config; it is stopped if it hangs.
   */
  const probeEngines = (): boolean => {
    if (jobs.isActive(PROBE_JOB_ID)) { return false; }
    const dir = path.join(config.dataDir, 'probe');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    writeFileAtomicSync(configPath, JSON.stringify({ agentTaskPlayer: { fullAuto: false } }, null, 2), 0o600);
    const { env } = workerEnv(configPath, []);
    let result = false;
    let timer: NodeJS.Timeout | null = null;
    const job: ProbeJob = { kind: 'probe' };
    engineCache.begin();
    const started = jobs.start({
      projectId: PROBE_JOB_ID, job, jobPath: path.join(dir, 'job.json'), workspace: dir, env,
      onEvent: (ev) => {
        if (ev.event === 'probe-result') { engineCache.record(ev.engines); result = true; }
      },
      onEnd: (end) => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!result) {
          engineCache.fail(end.spawnError ?? (end.status === 'stopped' ? 'The engine probe timed out.' : (end.stderrTail || `The engine probe exited with code ${end.exitCode}.`)));
        }
      },
    });
    if (!started.ok) {
      engineCache.fail(started.message);
      log(`engine probe refused: ${started.message}`);
      return false;
    }
    timer = setTimeout(() => { timer = null; jobs.stop(PROBE_JOB_ID); }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    return true;
  };

  const enginesDto = () => {
    const snap = engineCache.snapshot();
    return {
      checkedAt: snap.checkedAt,
      inProgress: snap.inProgress || jobs.isActive(PROBE_JOB_ID),
      error: snap.error,
      masterKeyConfigured: secrets.hasMasterKey(),
      rows: buildEngineRows(snap, keyStatus),
    };
  };

  // ─── Handlers ───

  const H: Record<string, Handler> = {};
  const body = async <T>(ctx: Ctx, v: Validator<T>): Promise<T> => parseBody(v, await readJsonBody(ctx.req));

  H['GET /healthz'] = async (ctx) => sendJson(ctx.res, 200, { ok: true });

  const bootstrapNeeded = (): boolean => !users.list().some((u) => u.roles.includes('admin')) && config.bootstrapToken !== null;

  H['GET /api/bootstrap/status'] = async (ctx) => sendJson(ctx.res, 200, { needed: bootstrapNeeded() });

  H['POST /api/bootstrap'] = async (ctx) => {
    if (!bootstrapNeeded()) { throw new HttpError(404, 'not-found'); }
    const b = await body(ctx, S.bootstrap);
    // Reserve the attempt synchronously (as login does), so parallel guesses all count.
    const gate = limiter.begin('__bootstrap', ctx.ip);
    if (!gate.allowed) { throw new HttpError(429, 'rate-limited', 'Too many attempts. Try again later.', { retryAfterSec: gate.retryAfterSec }); }
    const { attempt } = gate;
    if (!safeEqual(b.token, config.bootstrapToken)) {
      attempt.fail();
      throw new HttpError(403, 'bad-bootstrap-token', 'The bootstrap token is not correct.');
    }
    let u: UserRecord;
    try {
      const policy = validatePasswordPolicy(b.password);
      if (policy) { throw new HttpError(400, 'weak-password', policy); }
      u = await users.create({ username: b.username, displayName: b.displayName, roles: ['admin'], password: b.password });
    } catch (err) {
      attempt.cancel(); // the token was right: a weak password or a bad username is not a guess
      throw err;
    }
    attempt.succeed();
    writeAudit(ctx, { actor: u, action: 'user.create', target: u.username, after: { roles: u.roles, via: 'bootstrap' } });
    sendJson(ctx.res, 201, { user: toPublicUser(u) });
  };

  H['GET /api/session'] = async (ctx) => {
    if (ctx.user && ctx.session) {
      sendJson(ctx.res, 200, {
        user: toPublicUser(ctx.user), csrfToken: ctx.session.csrfToken, mustChangePassword: ctx.user.mustChangePassword,
        allowedActions: allowedActions(actorOf(ctx.user), SESSION_ACTIONS),
        meta: SESSION_META,
      });
      return;
    }
    const token = newPreAuthToken();
    sendJson(ctx.res, 200, { user: null, preAuthToken: token, bootstrapNeeded: bootstrapNeeded() }, { 'Set-Cookie': preAuthCookie(token, secure) });
  };

  H['POST /api/login'] = async (ctx) => {
    const b = await body(ctx, S.login);
    // Everything from here to the verify call is synchronous: the saturation
    // check, the limiter reservation and the scrypt enqueue happen in one tick,
    // so a burst of parallel attempts cannot all slip past the limit.
    if (scryptSaturated()) {
      throw new HttpError(503, 'busy', 'The server is busy. Try again in a moment.', { retryAfterSec: 5 });
    }
    const gate = limiter.begin(b.username, ctx.ip);
    if (!gate.allowed) {
      throw new HttpError(429, 'rate-limited', 'Too many failed sign-in attempts. Try again in 15 minutes.', { retryAfterSec: gate.retryAfterSec });
    }
    const { attempt } = gate;
    let ok: boolean;
    const u = users.findByUsername(b.username);
    const usable = !!u && !u.disabled;
    try {
      ok = (await verify(b.password, usable ? u.passwordHash : DUMMY_HASH)) && usable;
    } catch (err) {
      attempt.cancel();
      throw err;
    }
    if (!ok || !u) {
      attempt.fail();
      // Nobody is signed in, so there is no actor: the attempted account is the
      // TARGET, never the actor (a stranger's guess must not read as the user's
      // own action). Named only when it exists — no log of typos or passwords.
      writeAudit(ctx, { action: 'login.failure', target: u ? u.username : '(unknown account)' });
      throw new HttpError(401, 'bad-credentials', 'Username or password is incorrect.');
    }
    attempt.succeed();
    const s = sessions.create(u);
    writeAudit(ctx, { actor: u, action: 'login.success', target: u.username });
    sendJson(ctx.res, 200, { user: toPublicUser(u), csrfToken: s.csrfToken, mustChangePassword: u.mustChangePassword }, { 'Set-Cookie': sessionCookie(s.sid, secure) });
  };

  H['POST /api/logout'] = async (ctx) => {
    await body(ctx, S.empty);
    sessions.destroy(ctx.sid);
    sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secure) });
  };

  H['POST /api/me/password'] = async (ctx) => {
    const u = ctx.user!;
    const b = await body(ctx, S.mePassword);
    // A stolen session must not become an unlimited current-password oracle:
    // wrong guesses are limited per USER (any IP), reserved before scrypt runs.
    if (scryptSaturated()) {
      throw new HttpError(503, 'busy', 'The server is busy. Try again in a moment.', { retryAfterSec: 5 });
    }
    const gate = passwordLimiter.begin(u.id, u.id);
    if (!gate.allowed) {
      throw new HttpError(429, 'rate-limited', 'Too many wrong current passwords. Try again in 15 minutes.', { retryAfterSec: gate.retryAfterSec });
    }
    const { attempt } = gate;
    let currentOk: boolean;
    try { currentOk = await verify(b.currentPassword, u.passwordHash); } catch (err) { attempt.cancel(); throw err; }
    if (!currentOk) {
      attempt.fail();
      throw new HttpError(403, 'bad-credentials', 'Current password is incorrect.');
    }
    attempt.succeed();
    const policy = validatePasswordPolicy(b.newPassword);
    if (policy) { throw new HttpError(400, 'weak-password', policy); }
    const updated = await users.setPassword(u.id, b.newPassword, false);
    sessions.destroyAllForUser(u.id);
    const s = sessions.create(updated);
    writeAudit(ctx, { action: 'user.password-set', target: u.username, after: { temporary: false, self: true } });
    sendJson(ctx.res, 200, { user: toPublicUser(updated), csrfToken: s.csrfToken }, { 'Set-Cookie': sessionCookie(s.sid, secure) });
  };

  // ─── Admin ───

  H['GET /api/admin/users'] = async (ctx) => sendJson(ctx.res, 200, { users: users.list().map(toPublicUser) });

  H['POST /api/admin/users'] = async (ctx) => {
    const b = await body(ctx, S.createUser);
    const policy = validatePasswordPolicy(b.password);
    if (policy) { throw new HttpError(400, 'weak-password', policy); }
    const u = await users.create({ username: b.username, displayName: b.displayName, roles: b.roles, password: b.password, mustChangePassword: true });
    writeAudit(ctx, { action: 'user.create', target: u.username, after: { roles: u.roles } });
    sendJson(ctx.res, 201, { user: toPublicUser(u) });
  };

  H['PATCH /api/admin/users/:id'] = async (ctx) => {
    const b = await body(ctx, S.patchUser);
    const target = users.findById(ctx.params.id);
    if (!target) { throw new HttpError(404, 'not-found', 'User not found.'); }
    if (b.password !== undefined) {
      const policy = validatePasswordPolicy(b.password);
      if (policy) { throw new HttpError(400, 'weak-password', policy); }
    }
    let current = target;
    if (b.roles !== undefined) {
      const before = current.roles;
      current = users.setRoles(target.id, b.roles);
      sessions.destroyAllForUser(target.id);
      writeAudit(ctx, { action: 'user.role-change', target: target.username, before: { roles: before }, after: { roles: current.roles } });
    }
    if (b.disabled !== undefined && b.disabled !== current.disabled) {
      current = b.disabled ? users.disable(target.id) : users.enable(target.id);
      sessions.destroyAllForUser(target.id);
      writeAudit(ctx, { action: b.disabled ? 'user.disable' : 'user.enable', target: target.username });
    }
    if (b.password !== undefined) {
      current = await users.setPassword(target.id, b.password, true);
      sessions.destroyAllForUser(target.id);
      writeAudit(ctx, { action: 'user.password-set', target: target.username, after: { temporary: true } });
    }
    sendJson(ctx.res, 200, { user: toPublicUser(current) });
  };

  H['GET /api/admin/audit'] = async (ctx) => {
    const q = ctx.url.searchParams;
    const query: AuditQuery = {};
    for (const k of ['actor', 'action', 'projectId', 'from', 'to'] as const) {
      const v = q.get(k);
      if (v) { query[k] = v.slice(0, 128); }
    }
    for (const k of ['before', 'limit'] as const) {
      const v = q.get(k);
      if (v !== null) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) { throw new ValidationError(k, 'expected a non-negative integer'); }
        query[k] = n;
      }
    }
    const entries = audit.query(query);
    const limit = Math.max(1, Math.min(AUDIT_MAX_PAGE, Math.floor(query.limit ?? AUDIT_MAX_PAGE)));
    // A full page may have more behind it: the cursor is the oldest seq shown, if anything older matches.
    const oldest = entries.length > 0 ? entries[entries.length - 1].seq : null;
    const more = entries.length >= limit && oldest !== null && audit.query({ ...query, before: oldest, limit: 1 }).length > 0;
    sendJson(ctx.res, 200, { entries, nextBefore: more ? oldest : null, actions: [...AUDIT_ACTIONS] });
  };

  // ─── Engines ───

  H['GET /api/admin/engines'] = async (ctx) => sendJson(ctx.res, 200, enginesDto());

  H['POST /api/admin/engines/recheck'] = async (ctx) => {
    await body(ctx, S.empty);
    if (jobs.isActive(PROBE_JOB_ID)) { throw new HttpError(409, 'probe-active', 'An engine check is already running.'); }
    if (!probeEngines()) {
      throw new HttpError(429, 'probe-refused', engineCache.snapshot().error ?? 'The engine check could not start. Try again shortly.');
    }
    sendJson(ctx.res, 202, enginesDto());
  };

  const keyedEngineParam = (ctx: Ctx): EngineId => {
    const e = ctx.params.engine;
    if (!isKeyedEngine(e)) { throw new HttpError(404, 'not-found', 'This engine has no stored API key.'); }
    return e;
  };

  H['PUT /api/admin/engines/:engine/key'] = async (ctx) => {
    const engine = keyedEngineParam(ctx);
    const b = await body(ctx, S.setKey);
    if (!secrets.hasMasterKey()) {
      throw new HttpError(503, 'no-master-key', 'API keys cannot be stored: the server has no master key (MOAG_MASTER_KEY_FILE).');
    }
    const rotated = secrets.status(engine).set;
    let status;
    try { status = secrets.set(engine, b.value); } catch (err) {
      if (err instanceof NoMasterKeyError) { throw new HttpError(503, 'no-master-key', err.message); }
      throw new HttpError(400, 'invalid-key', 'The key must be 8-512 printable characters without spaces.');
    }
    // The audit entry says only that a key was set — never any character of it.
    writeAudit(ctx, { action: 'engine.key-set', target: engine, after: { rotated } });
    sendJson(ctx.res, 200, { engine, status });
  };

  H['DELETE /api/admin/engines/:engine/key'] = async (ctx) => {
    const engine = keyedEngineParam(ctx);
    await body(ctx, S.empty);
    const cleared = secrets.clear(engine);
    if (cleared) { writeAudit(ctx, { action: 'engine.key-clear', target: engine }); }
    sendJson(ctx.res, 200, { engine, cleared, status: secrets.status(engine) });
  };

  // ─── Admin settings ───

  const settingsDto = () => ({ settings: settings.get(), plannerLockedEngines: [...PLANNER_LOCKED_ENGINES] });

  H['GET /api/admin/settings'] = async (ctx) => sendJson(ctx.res, 200, settingsDto());

  H['PATCH /api/admin/settings'] = async (ctx) => {
    const b = await body(ctx, S.patchSettings);
    const { before, after } = settings.update(b);
    // Audited only when something actually changed.
    if (before.allowPlannerFileAccess !== after.allowPlannerFileAccess) {
      writeAudit(ctx, {
        action: 'settings.update', target: 'allowPlannerFileAccess',
        before: { allowPlannerFileAccess: before.allowPlannerFileAccess }, after: { allowPlannerFileAccess: after.allowPlannerFileAccess },
      });
      log(`settings: allowPlannerFileAccess ${before.allowPlannerFileAccess} -> ${after.allowPlannerFileAccess} by ${ctx.user?.username ?? '?'}`);
    }
    sendJson(ctx.res, 200, settingsDto());
  };

  // ─── Admin: force-release a project's job lock ───

  // Deletes job.lock when task pids outlived their job (or a predecessor's
  // holder is stuck). Kills NOTHING: the admin confirms the recorded processes
  // are gone (or tree-kills them) first. Refused while a job runs here.
  H['POST /api/admin/projects/:id/lock/release'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.forceRelease);
    if (jobs.isActive(p.id)) { throw new HttpError(409, 'job-active', 'A job is running in this project. Stop it instead.'); }
    const r = jobs.forceReleaseLock(p.id);
    if (!r.ok) {
      if (r.reason === 'job-active') { throw new HttpError(409, 'job-active', 'A job is running in this project. Stop it instead.'); }
      throw new HttpError(409, 'not-locked', 'This project has no job lock to release.');
    }
    const before = r.before;
    writeAudit(ctx, {
      action: 'job.lock-force-release', projectId: p.id, target: p.name,
      before: { taskPids: before?.taskPids ?? [], workerPid: before?.workerPid ?? null, lingering: before?.lingering ?? false, expired: before?.expired ?? false },
      after: { reason: b.reason },
    });
    log(`project ${p.id}: job lock force-released by ${ctx.user?.username ?? '?'}`);
    sendJson(ctx.res, 200, { released: true });
  };

  H['GET /api/engines/availability'] = async (ctx) => {
    const snap = engineCache.snapshot();
    sendJson(ctx.res, 200, {
      checkedAt: snap.checkedAt,
      engines: SERVER_ENGINES.map((id) => {
        const row = snap.rows.find((r) => r.id === id);
        return { id, available: engineAvailable(id) ?? null, version: row?.version ?? null };
      }),
      unsupported: [...SERVER_FORBIDDEN_ENGINES],
    });
  };

  H['GET /api/users/approvers'] = async (ctx) => {
    const approvers = users.list().filter((u) => !u.disabled && u.roles.includes('approver'))
      .map((u) => ({ username: u.username, displayName: u.displayName }));
    sendJson(ctx.res, 200, { approvers });
  };

  // ─── Projects ───

  H['GET /api/projects'] = async (ctx) => sendJson(ctx.res, 200, {
    projects: projects.list().map((p) => projectDto(p, ctx.user!)),
    allowedActions: allowedActions(actorOf(ctx.user!), ['project.create']),
  });

  H['POST /api/projects'] = async (ctx) => {
    const b = await body(ctx, createProjectV);
    requireEngine(b.defaultEngine);
    const p = await intakeProject(projects, b, ctx.user!.id, {
      projectsRoot: config.projectsRoot, allowSsh: config.allowSshClone, serverEnv: deps.serverEnv, exec: deps.exec,
    });
    writeAudit(ctx, { action: 'project.create', projectId: p.id, target: p.name, after: { stack: p.stack, defaultEngine: p.defaultEngine, versionBudgetUsd: p.versionBudgetUsd, source: p.source.kind } });
    // Standards v1 is proposed right away (detection over the files git tracks plus the
    // stack's built-in profile; git is asked asynchronously and no model is), so a reviewer has
    // something to approve before the first plan. A failure here never fails the
    // create: the project simply has no proposal yet and a product owner can make one.
    try {
      const auto = await state.withProjectLock(p.id, () => proposeAutomatic(standards, p, { migrated: false, now: now() }));
      if (auto) {
        // Everything the first version brings is on record, measured against the empty baseline.
        writeAudit(ctx, { action: 'standards.propose', projectId: p.id, target: `standards v${auto.version}`, ...standardsAuditWithSeverity(p.id, auto, ['auto-proposed']) });
      }
    } catch (err) { log(`project ${p.id}: automatic standards proposal failed: ${(err as Error).message}`); }
    sendJson(ctx.res, 201, { project: projectDto(p, ctx.user!) });
  };

  /**
   * Stack recommendation for the create/settings form. Evidence is outcomes
   * recorded by server runs on engines connected now; without enough of it the
   * answer is the labelled static default, detected from the project's (or the
   * chosen folder's) repository files when possible. With evidence, the
   * response's `state` says whether it is a real recommendation or only
   * supporting evidence (single stack, poor completion, differs from detection).
   */
  H['GET /api/projects/recommendation'] = async (ctx) => {
    const q = ctx.url.searchParams;
    let repoDir: string | null = null;
    const projectId = q.get('projectId');
    const relPath = q.get('path');
    if (projectId !== null) {
      if (!PARAM_RE.test(projectId)) { throw new ValidationError('projectId', 'has an invalid format'); }
      repoDir = requireWorkspace(getProject(projectId));
    } else if (relPath !== null && relPath.trim() !== '') {
      repoDir = resolveProjectPath(config.projectsRoot, relPath);
    }
    const connected = SERVER_ENGINES.filter((e) => engineAvailable(e) === true);
    const evidence = outcomes.readAll();
    // A stack detected from the repo stays primary; measured outcomes only
    // "recommend" when they agree with it, compare stacks, and complete well.
    const detected = repoDir ? detectStackFromRepo(repoDir) : null;
    sendJson(ctx.res, 200, {
      recommendation: recommendStack(evidence.records, connected, detected),
      connectedEngines: connected,
      enginesCheckedAt: engineCache.snapshot().checkedAt,
    });
  };

  H['GET /api/projects/:id'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const st = state.load(p.id);
    const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
    const latest = latestVersion(plan);
    const lastRun = st.runs.length > 0 ? st.runs[st.runs.length - 1] : undefined;
    sendJson(ctx.res, 200, {
      project: projectDto(p, ctx.user!),
      plans: st.plans.map((x) => planDto(x, ctx.user!, startContext(p, st, x, plan))),
      runs: st.runs.map((r) => runDto(r, ctx.user!, p, st)),
      currentRun: lastRun ? runDetail(p, st, lastRun) : null,
      currentPlan: {
        playlists: plan.playlists.map((pl) => ({
          name: pl.name,
          tasks: pl.tasks.map((t) => ({ id: t.id, name: t.name, type: t.type ?? 'agent', status: t.status })),
        })),
      },
      latestVersion: latest ? { label: formatVersionLabel(latest.version), createdAt: latest.createdAt } : null,
      spend: spendFor(p, st, latest?.createdAt),
      runsDisabledReason: config.runsDisabledReason,
      activeJob: jobs.activeKind(p.id),
      // A live holder (e.g. task pids that outlived their job) keeps job.lock: a start would 409.
      lockHeld: jobs.isLockHeld(p.id),
      // Engine config the repo ships; an approved run loads it (the plan review card warns).
      repoEngineConfig: detectRepoEngineConfig(p.workspacePath),
    });
  };

  H['PATCH /api/projects/:id'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.patchProject);
    if (b.defaultEngine !== undefined) { requireEngine(b.defaultEngine); }
    const updated = projects.update(p.id, b);
    if (updated.defaultEngine !== p.defaultEngine && fs.existsSync(state.canonicalPlanPath(p.id))) {
      // Keep the stored canonical plan's engine equal to the project's (every load stamps it too).
      await state.withProjectLock(p.id, () => {
        state.saveCanonicalPlan(p.id, state.loadCanonicalPlan(p.id, updated.name, updated.defaultEngine), updated.defaultEngine);
      });
    }
    if (b.stack !== undefined && b.stack !== p.stack) {
      writeAudit(ctx, { action: 'project.stack-change', projectId: p.id, target: p.name, before: { stack: p.stack }, after: { stack: updated.stack } });
    }
    const changed: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const k of ['name', 'defaultEngine', 'versionBudgetUsd'] as const) {
      if (b[k] !== undefined && b[k] !== p[k]) { before[k] = p[k]; changed[k] = updated[k]; }
    }
    if (Object.keys(changed).length > 0) {
      writeAudit(ctx, { action: 'project.update', projectId: p.id, target: updated.name, before, after: changed });
    }
    sendJson(ctx.res, 200, { project: projectDto(updated, ctx.user!) });
  };

  // ─── PRD ───

  /** Who saved each PRD version (keyed by `createdAt`) and the latest override per label, from the audit log. */
  const prdAttribution = (projectId: string) => {
    const saves = new Map<string, { by: string; at: string }>();
    for (const e of audit.query({ action: 'prd.version-save', projectId, limit: 100 })) {
      const createdAt = (e.after as { createdAt?: unknown } | undefined)?.createdAt;
      if (typeof createdAt === 'string' && !saves.has(createdAt)) { saves.set(createdAt, { by: e.actorUsername, at: e.ts }); }
    }
    const overrides = new Map<string, { by: string; at: string; before: unknown; after: unknown }>();
    for (const e of audit.query({ action: 'prd.bump-override', projectId, limit: 100 })) {
      const label = (e.after as { version?: unknown } | undefined)?.version;
      if (typeof label === 'string' && !overrides.has(label)) { overrides.set(label, { by: e.actorUsername, at: e.ts, before: e.before, after: e.after }); }
    }
    return { saves, overrides };
  };

  H['GET /api/projects/:id/prd'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
    const st = state.load(p.id);
    const versions = plan.prdVersions ?? [];
    const latest = latestVersion(plan);
    const locked = latest ? st.overrideLocked[latest.createdAt] === true : false;
    const scope = describeDeltaScope(plan);
    const open = latest ? st.plans.find((x) => x.forVersionCreatedAt === latest.createdAt && OPEN_PLAN_STATUSES.includes(x.status)) : undefined;
    const reserved = [...collectReservedRequirementIds(plan)];
    const { saves, overrides } = prdAttribution(p.id);
    const spend = spendFor(p, st, latest?.createdAt);
    const std = standardsView(p.id);
    sendJson(ctx.res, 200, {
      versions: versions.map((v, i) => {
        // Each version's diff against its predecessor, computed exactly as at save time.
        const diff = i > 0 ? computeLatestDiff(versions.slice(0, i + 1), reserved) : null;
        const rationale = diff ? recommendBump(diff, versions[i - 1].text !== v.text).rationale : null;
        return {
          version: v.version, label: formatVersionLabel(v.version), createdAt: v.createdAt,
          recommendedBump: v.recommendedBump ?? null, chosenBump: v.chosenBump ?? null,
          rationale,
          diff: diff ? { added: diff.added, changed: diff.changed, removed: diff.removed, unchangedCount: diff.unchanged.length } : null,
          savedBy: saves.get(v.createdAt) ?? null,
          override: overrides.get(v.version) ?? null,
        };
      }),
      latest: latest ? { createdAt: latest.createdAt, text: latest.text } : null,
      deltaScope: scope,
      requirementCount: latest ? latestRequirements(plan).length : 0,
      overrideLocked: locked,
      openPlan: open ? { id: open.id, status: open.status } : null,
      bumps: [...SEMVER_BUMPS],
      engine: p.defaultEngine,
      spend,
      runsDisabledReason: config.runsDisabledReason,
      // Why the generate actions are absent although the role and the PRD allow them
      // (an absent action alone cannot tell the UI which notice to show).
      planBlockedReason: std.effective ? null : 'standards-not-approved',
      standards: { effectiveVersion: std.effective?.version ?? null, pendingVersion: std.pending?.version ?? null, state: std.state },
      allowedActions: allowedActions(actorOf(ctx.user!), ['prd.save', 'prd.bump-override', 'plan.generate', 'plan.generate-initial'], {
        // Mirrors requireStandards: no plan is generated until a standards version is approved.
        standardsApproved: std.effective !== null,
        overrideLocked: locked,
        canOverride: !!latest?.recommendedBump && versions.length > 1,
        hasDeltaScope: scope !== null,
        versionCount: versions.length,
        openPlan: !!open,
        runsDisabled: config.runsDisabledReason !== null,
        // Mirrors requireBudget: generation is refused once the version's cap is used up.
        budgetExhausted: !!latest && !spend.noCap && !((spend.remainingUsd ?? 0) > 0),
      }),
    });
  };

  H['POST /api/projects/:id/prd/versions'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.savePrd);
    await state.withProjectLock(p.id, () => {
      const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
      const r = savePrdVersion(plan, { text: b.text, baseCreatedAt: b.baseCreatedAt });
      if (!r.ok) { throw new HttpError(r.status, r.reason, r.message, r.errors ? { errors: r.errors } : undefined); }
      state.saveCanonicalPlan(p.id, plan, p.defaultEngine);
      writeAudit(ctx, {
        action: 'prd.version-save', projectId: p.id, target: r.label,
        after: { version: r.entry.version, createdAt: r.entry.createdAt, recommendedBump: r.entry.recommendedBump ?? null, chosenBump: r.entry.chosenBump ?? null },
      });
      sendJson(ctx.res, 201, {
        version: { version: r.entry.version, label: r.label, createdAt: r.entry.createdAt, recommendedBump: r.entry.recommendedBump ?? null, chosenBump: r.entry.chosenBump ?? null },
        text: r.entry.text, diff: r.diff, recommendation: r.recommendation, dropped: r.dropped,
      });
    });
  };

  H['POST /api/projects/:id/prd/versions/latest/bump'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.bump);
    await state.withProjectLock(p.id, () => {
      const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
      const st = state.load(p.id);
      const r = overrideBump(plan, { bump: b.bump, expectedCreatedAt: b.expectedCreatedAt, locked: st.overrideLocked[b.expectedCreatedAt] === true });
      if (!r.ok) { throw new HttpError(r.status, r.reason, r.message); }
      state.saveCanonicalPlan(p.id, plan, p.defaultEngine);
      writeAudit(ctx, {
        action: 'prd.bump-override', projectId: p.id, target: formatVersionLabel(r.after.version),
        before: r.before, after: { ...r.after, recommended: r.recommended ?? null },
      });
      sendJson(ctx.res, 200, { before: r.before, after: r.after, recommended: r.recommended ?? null, label: formatVersionLabel(r.after.version) });
    });
  };

  // ─── Standards ───

  H['GET /api/projects/:id/standards'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    sendJson(ctx.res, 200, { standards: standardsDto(p, ctx.user!) });
  };

  /** The `:version` path parameter as a version number; anything else names no version. */
  const standardsVersionParam = (ctx: Ctx): number => {
    const raw = ctx.params.version;
    if (!/^[1-9]\d{0,5}$/.test(raw)) { throw new HttpError(404, 'not-found', 'Standards version not found.'); }
    return Number(raw);
  };

  H['POST /api/projects/:id/standards/versions'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.proposeStandards);
    const checked = validateProfile(b.profile);
    if (!checked.ok) {
      throw new HttpError(400, 'invalid-standards', 'These standards are not valid. Fix the listed problems and submit again.', { errors: checked.errors });
    }
    await state.withProjectLock(p.id, () => {
      let provenance: StandardsProvenance;
      try { provenance = userProvenance(p.id, checked.profile, b.baseVersion, ctx.user!.username); }
      catch (err) { throw standardsRefusal(err); }
      let created: StandardsVersionRecord;
      try {
        created = standards.propose(p.id, {
          profile: checked.profile, provenance, origin: 'user', proposedBy: ctx.user!.id, baseVersion: b.baseVersion,
        }, now());
      } catch (err) { throw standardsRefusal(err); }
      // Promoting or demoting a rule changes what can stop a release: flagged, and named.
      writeAudit(ctx, {
        action: 'standards.propose', projectId: p.id, target: `standards v${created.version}`,
        ...standardsAuditWithSeverity(p.id, created),
      });
      sendJson(ctx.res, 201, { version: created.version, standards: standardsDto(p, ctx.user!) });
    });
  };

  H['POST /api/projects/:id/standards/versions/:version/approve'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const version = standardsVersionParam(ctx);
    const b = await body(ctx, S.approveStandards);
    await state.withProjectLock(p.id, () => {
      let decided: StandardsVersionRecord;
      try {
        decided = standards.approve(p.id, version, {
          contentHash: b.contentHash, by: ctx.user!.id, acknowledgedEnforcementHash: b.acknowledgedEnforcementHash,
        }, now());
      }
      catch (err) { throw standardsRefusal(err); }
      // Someone holding both roles approved their own proposal: allowed, and visible in the audit log.
      // So is an approval that changes which rules can stop a release.
      writeAudit(ctx, {
        action: 'standards.approve', projectId: p.id, target: `standards v${decided.version}`,
        flags: [],
        ...standardsAuditWithSeverity(p.id, decided, decided.proposedBy === ctx.user!.id ? ['self-approval'] : []),
      });
      sendJson(ctx.res, 200, { version: decided.version, standards: standardsDto(p, ctx.user!) });
    });
  };

  H['POST /api/projects/:id/standards/versions/:version/reject'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const version = standardsVersionParam(ctx);
    const b = await body(ctx, S.rejectStandards);
    await state.withProjectLock(p.id, () => {
      let decided: StandardsVersionRecord;
      try { decided = standards.reject(p.id, version, { reason: b.reason, by: ctx.user!.id }, now()); }
      catch (err) { throw standardsRefusal(err); }
      writeAudit(ctx, { action: 'standards.reject', projectId: p.id, target: `standards v${decided.version}`, after: standardsAudit(decided) });
      sendJson(ctx.res, 200, { version: decided.version, standards: standardsDto(p, ctx.user!) });
    });
  };

  H['POST /api/projects/:id/standards/accept-defaults'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.approveStandards);
    await state.withProjectLock(p.id, () => {
      let decided: StandardsVersionRecord;
      try {
        decided = standards.acceptDefaults(p.id, {
          contentHash: b.contentHash, by: ctx.user!.id, acknowledgedEnforcementHash: b.acknowledgedEnforcementHash,
        }, now());
      }
      catch (err) { throw standardsRefusal(err); }
      // Recorded under its own action, never as an approval: nobody reviewed this version.
      // It takes effect all the same, so what it changes about blocking is named here too.
      writeAudit(ctx, { action: 'standards.accept-defaults', projectId: p.id, target: `standards v${decided.version}`, ...standardsAuditWithSeverity(p.id, decided) });
      sendJson(ctx.res, 200, { version: decided.version, standards: standardsDto(p, ctx.user!) });
    });
  };

  // ─── Plans ───

  H['POST /api/projects/:id/plans'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.generatePlan);
    if (b.mode === 'initial' && !canPerform(actorOf(ctx.user!), 'plan.generate-initial')) {
      throw new HttpError(403, 'forbidden', "You don't have permission to do that.");
    }
    requireRunsEnabled();
    requireEngine(p.defaultEngine);
    // Planner lockdown: an engine that cannot be denied file access never plans,
    // unless an admin has turned on planner file access (audited when changed).
    const plannerFileAccess = settings.get().allowPlannerFileAccess;
    const refusal = plannerFileAccessRefusal(p.defaultEngine, plannerFileAccess);
    if (refusal) { throw new HttpError(409, 'planner-file-access', refusal, { engine: p.defaultEngine }); }
    const plannerUnlocked = !PLANNER_LOCKED_ENGINES.includes(p.defaultEngine);
    await state.withProjectLock(p.id, async () => {
      const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
      const latest = latestVersion(plan);
      if (!latest) { throw new HttpError(409, 'no-prd', 'Save a PRD version first.'); }
      const versions = plan.prdVersions ?? [];
      if (b.mode === 'initial' && versions.length !== 1) {
        throw new HttpError(409, 'not-first-version', 'An initial plan is only generated for the first PRD version.');
      }
      if (b.mode === 'delta' && !describeDeltaScope(plan)) {
        throw new HttpError(409, 'no-delta-scope', 'This version adds or changes no requirements, so there is nothing to plan.');
      }
      const st = state.load(p.id);
      const open = st.plans.find((x) => x.forVersionCreatedAt === latest.createdAt && OPEN_PLAN_STATUSES.includes(x.status));
      if (open) { throw new HttpError(409, 'plan-exists', `A plan for this version is already ${open.status}.`, { planId: open.id }); }
      const remaining = requireBudget(p, st, latest.createdAt);
      const repo = requireWorkspace(p);
      // Before any directory or job exists: no approved standards, no plan — nothing is
      // created, started or audited.
      const approvedStandards = requireStandards(p);

      const planId = randomUUID();
      const dir = path.join(state.projectDir(p.id), 'plans', planId);
      const planPath = path.join(dir, 'plan.json');
      const outPath = path.join(dir, 'outcome.json');
      // The planning agent never starts in the repo (B1): a repo can ship engine
      // config (.claude/settings.json hooks, .mcp.json, .gemini/) that would run
      // as the server uid on a product-owner click. It gets an empty server-owned
      // scratch dir as cwd and a server-generated file listing as prompt context.
      const workspace = path.join(dir, 'work');
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const repoListingPath = path.join(dir, 'repo-files.txt');
      writeFileAtomicSync(repoListingPath, await buildRepoListing(repo, deps.exec), 0o600);
      writeFileAtomicSync(planPath, JSON.stringify(dehydratePlan(plan), null, 2), 0o600);
      const configPath = writeWorkerConfig(dir, p, remaining, 'plan');
      // The planner is told the approved standards through a server-written job file.
      const standardsPath = writeStandardsJobFile(dir, approvedStandards, null);
      const job: PlanJob = { kind: 'plan', mode: b.mode, workspace, planPath, outPath, engine: p.defaultEngine, repoListingPath, standardsPath };
      const { env, redact } = workerEnv(configPath, [p.defaultEngine]);
      const started = jobs.start({
        projectId: p.id, job, jobPath: path.join(dir, 'job.json'), workspace, env, redact,
        spendKey: latest.createdAt, onEnd: onPlanEnd(p.id, planId, outPath, redact),
      });
      if (!started.ok) { throw new HttpError(started.status, started.reason, started.message); }
      const review: PlanReview = {
        id: planId, status: 'generating', mode: b.mode, engine: p.defaultEngine,
        forVersionCreatedAt: latest.createdAt, forVersionLabel: latest.version,
        requestedBy: ctx.user!.id, requestedAt: now().toISOString(),
        standardsVersion: approvedStandards.version,
      };
      state.update(p.id, (s) => { s.plans.push(review); s.overrideLocked[latest.createdAt] = true; });
      writeAudit(ctx, { action: 'plan.generate', projectId: p.id, target: `PRD ${formatVersionLabel(latest.version)} ${b.mode}`, after: { planId, engine: p.defaultEngine, ...(plannerUnlocked ? { plannerFileAccess: true } : {}) } });
      sendJson(ctx.res, 202, { plan: planDto(review, ctx.user!) });
    });
  };

  const decidePlan = (kind: 'approve' | 'reject'): Handler => async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = kind === 'approve' ? await body(ctx, S.approvePlan) : await body(ctx, S.rejectPlan);
    await state.withProjectLock(p.id, () => {
      const st = state.load(p.id);
      const review = st.plans.find((x) => x.id === ctx.params.planId);
      if (!review) { throw new HttpError(404, 'not-found', 'Plan not found.'); }
      if (review.status !== 'pending') {
        throw new HttpError(409, 'already-decided', `This plan is ${review.status}.`, { status: review.status, decidedBy: review.decidedBy ?? null, decidedAt: review.decidedAt ?? null });
      }
      const flags = review.requestedBy === ctx.user!.id ? ['self-approval'] : [];
      if (kind === 'reject') {
        const reason = (b as { reason: string }).reason;
        review.status = 'rejected';
        review.decidedBy = ctx.user!.id;
        review.decidedAt = now().toISOString();
        review.reason = reason;
        state.save(p.id, st);
        writeAudit(ctx, { action: 'plan.reject', projectId: p.id, target: review.playlist?.name ?? review.id, after: { planId: review.id, reason } });
        sendJson(ctx.res, 200, { plan: planDto(review, ctx.user!) });
        return;
      }
      // Re-evaluated at approval, not only when the plan was generated: a plan that was
      // pending before the project had standards is not approved while none is approved.
      requireStandards(p);
      if ((b as { contentHash: string }).contentHash !== review.contentHash || !review.playlist) {
        throw new HttpError(409, 'hash-mismatch', 'The plan changed since you reviewed it. Reload and review again.');
      }
      const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
      if (latestVersion(plan)?.createdAt !== review.forVersionCreatedAt) {
        throw new HttpError(409, 'stale', 'A newer PRD version was saved after this plan was generated. Request a new plan.');
      }
      // Re-validated now, not read from the stored review: a plan generated
      // before a review rule existed is refused by that rule too.
      requireReviewPasses(review);
      // The pending card shows the engine the plan was generated with
      // (review.engine); that is what the reviewer approves. If the project's
      // default changed while the plan was pending, approving would bind an
      // engine nobody reviewed — refuse instead.
      if (review.engine !== p.defaultEngine) {
        throw new HttpError(409, 'engine-changed',
          `This plan was generated for ${review.engine}, but the project now uses ${p.defaultEngine}. Switch the project back or request a new plan.`,
          { planEngine: review.engine, projectEngine: p.defaultEngine });
      }
      let next: Plan;
      try {
        const file = dehydratePlan(plan);
        file.playlists.push(review.playlist);
        next = hydratePlan(file, 'plan');
      } catch (err) {
        throw new HttpError(422, 'invalid-playlist', `The generated playlist is not valid: ${(err as Error).message}`);
      }
      state.saveCanonicalPlan(p.id, next, p.defaultEngine);
      review.status = 'approved';
      review.decidedBy = ctx.user!.id;
      review.decidedAt = now().toISOString();
      review.playlistIndex = next.playlists.length - 1;
      review.approvedEngine = review.engine;
      state.save(p.id, st);
      writeAudit(ctx, { action: 'plan.approve', projectId: p.id, target: review.playlist.name, after: { planId: review.id, contentHash: review.contentHash, engine: review.engine }, flags });
      sendJson(ctx.res, 200, { plan: planDto(review, ctx.user!) });
    });
  };
  H['POST /api/projects/:id/plans/:planId/approve'] = decidePlan('approve');
  H['POST /api/projects/:id/plans/:planId/reject'] = decidePlan('reject');

  H['POST /api/projects/:id/plans/:planId/cancel'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    await body(ctx, S.empty);
    await state.withProjectLock(p.id, () => {
      const st = state.load(p.id);
      const review = st.plans.find((x) => x.id === ctx.params.planId);
      if (!review) { throw new HttpError(404, 'not-found', 'Plan not found.'); }
      if (!canPerform(actorOf(ctx.user!), 'plan.cancel', { requestedBy: review.requestedBy, planStatus: review.status })) {
        if (review.status !== 'generating' && review.status !== 'pending') {
          throw new HttpError(409, 'already-decided', `This plan is ${review.status}.`);
        }
        throw new HttpError(403, 'forbidden', 'Only the requester or an admin can cancel this plan.');
      }
      if (review.status === 'generating') {
        jobs.stop(p.id); // the plan becomes `cancelled` when the worker exits
      } else {
        review.status = 'cancelled';
        state.save(p.id, st);
      }
      writeAudit(ctx, { action: 'plan.cancel', projectId: p.id, target: review.id });
      sendJson(ctx.res, 202, { plan: planDto(review, ctx.user!) });
    });
  };

  // ─── Runs ───

  H['POST /api/projects/:id/runs'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = await body(ctx, S.startRun);
    requireRunsEnabled();
    await state.withProjectLock(p.id, async () => {
      const st = state.load(p.id);
      const review = st.plans.find((x) => x.id === b.planId);
      if (!review || (review.status !== 'approved' && review.status !== 'ran')) {
        throw new HttpError(409, 'plan-not-approved', 'Only a reviewer-approved plan can run.');
      }
      if (jobs.isActive(p.id) || st.runs.some((r) => r.status === 'running')) {
        throw new HttpError(409, 'job-active', 'This project already has a run in progress.');
      }
      requireApprovedEngine(p, review);
      // A plan generated under standards never runs unchecked: if the store has lost every
      // approved version, fail closed. (A legacy plan with no standards version still runs.)
      if (standardsLost(p, review)) { requireStandards(p); }
      // Stamped with the project's engine: the snapshot's defaultEngine is what the runner uses.
      const canonical = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
      requirePlanEngines(canonical);
      // An approval is not a waiver: a plan approved before a review rule existed
      // (a `parallel` playlist, a `cwd` outside the workspace) never starts. Both
      // the approved playlist and the canonical copy the runner would load are checked.
      const runs = review.playlistIndex === undefined ? undefined : dehydratePlan(canonical).playlists[review.playlistIndex];
      requireReviewPasses(review, runs ? [runs] : [], 'This plan no longer passes review, so it cannot start. ');
      const remaining = requireBudget(p, st, review.forVersionCreatedAt);
      const workspace = requireWorkspace(p);
      // The run is held to the standards in effect NOW — the latest approved version, which
      // may be newer than the one its plan was generated under — and that version is frozen
      // on the run record with the base its check diffs against. A project with no approved
      // version (a legacy plan) runs without standards, and says so.
      const frozen = standardsView(p.id).effective;
      // No job can start in this project while we wait: every start runs under this lock.
      const baseRef = frozen ? await standardsBaseRef(st, workspace) : null;
      const run: RunRecord = {
        id: randomUUID(), planId: review.id, status: 'running', startedBy: ctx.user!.id, startedAt: now().toISOString(),
        versionCreatedAt: review.forVersionCreatedAt, stack: p.stack, segments: 1,
        ...(frozen ? { standardsVersion: frozen.version, standardsHash: frozen.contentHash, baseRef } : {}),
      };
      const dir = state.runDir(p.id, run.id);
      writeFileAtomicSync(path.join(dir, 'plan.json'), JSON.stringify(dehydratePlan(canonical), null, 2), 0o600);
      spawnRunSegment(p, run, review, remaining, workspace);
      st.runs.push(run);
      review.status = 'ran';
      state.save(p.id, st);
      writeAudit(ctx, { action: 'run.start', projectId: p.id, target: run.id, after: { planId: review.id, engine: p.defaultEngine } });
      sendJson(ctx.res, 202, { run: runDto(run, ctx.user!, p, st) });
    });
  };

  H['POST /api/projects/:id/runs/:runId/stop'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    await body(ctx, S.empty);
    await state.withProjectLock(p.id, () => {
      const st = state.load(p.id);
      const run = st.runs.find((r) => r.id === ctx.params.runId);
      if (!run) { throw new HttpError(404, 'not-found', 'Run not found.'); }
      if (run.status !== 'running' || jobs.activeKind(p.id) !== 'run') {
        throw new HttpError(409, 'not-running', `This run is ${run.status}.`);
      }
      // Idempotent: stopping a segment already being stopped changes nothing and is not audited again.
      if (jobs.isStopRequested(p.id)) {
        sendJson(ctx.res, 200, { run: runDto(run, ctx.user!, p, st), alreadyStopping: true });
        return;
      }
      jobs.stop(p.id);
      run.stoppedBy = ctx.user!.id;
      state.save(p.id, st);
      writeAudit(ctx, { action: 'run.stop', projectId: p.id, target: run.id });
      sendJson(ctx.res, 202, { run: runDto(run, ctx.user!, p, st) });
    });
  };

  const decideGate = (kind: 'approve' | 'reject' | 'skip'): Handler => async (ctx) => {
    const p = getProject(ctx.params.id);
    const b = kind === 'approve' ? await body(ctx, S.gateApprove)
      : kind === 'reject' ? await body(ctx, S.gateReject) : await body(ctx, S.gateSkip);
    const note = (b as { note?: string; reason?: string }).note ?? (b as { reason?: string }).reason;
    await state.withProjectLock(p.id, () => {
      const st = state.load(p.id);
      const run = st.runs.find((r) => r.id === ctx.params.runId);
      if (!run) { throw new HttpError(404, 'not-found', 'Run not found.'); }
      if (run.status !== 'awaiting-approval' || !run.gate) {
        const last = run.gateDecisions?.[run.gateDecisions.length - 1];
        throw new HttpError(409, 'not-awaiting-approval', `This run is ${run.status}.`, { lastDecision: last ?? null });
      }
      const gate = run.gate;
      const decision = { action: kind, by: ctx.user!.id, at: now().toISOString(), ...(note ? { note } : {}) };
      const flags = run.startedBy === ctx.user!.id ? ['self-approval'] : [];
      const action = kind === 'approve' ? 'gate.approve' : kind === 'reject' ? 'gate.reject' : 'gate.skip';

      if (kind === 'reject') {
        run.status = 'ship-rejected';
        run.gateDecisions = [...(run.gateDecisions ?? []), decision];
        delete run.gate;
        state.save(p.id, st);
        writeAudit(ctx, { action, projectId: p.id, target: gate.name, after: { runId: run.id, taskId: gate.taskId, note } });
        sendJson(ctx.res, 200, { run: runDto(run, ctx.user!, p, st) });
        return;
      }

      // A ship is never approved over a standards check that says it must not ship. The
      // pre-gate report is the one the approver is looking at: while it shows a blocking
      // failure, or a blocking rule or command that was not checked, approving is refused.
      // (A skip ships nothing, so it stays possible.) Read from the run record in the
      // server's own state file, never from the agent-writable run directory.
      if (kind === 'approve') {
        const pre = run.standardsSummary;
        if (run.standardsVersion !== undefined && pre && pre.phase === 'pre-gate' && (pre.failed > 0 || (pre.blockingNotChecked ?? 0) > 0)) {
          const why = pre.failed > 0
            ? `${pre.failed} blocking rule${pre.failed === 1 ? '' : 's'} or command${pre.failed === 1 ? '' : 's'} failed`
            : `${pre.blockingNotChecked} blocking rule${pre.blockingNotChecked === 1 ? '' : 's'} or command${pre.blockingNotChecked === 1 ? ' was' : 's were'} not checked`;
          throw new HttpError(409, 'standards-blocking',
            `This ship can't be approved: the standards check before the gate shows that ${why}. Reject the ship, or fix the work and run again.`,
            { failed: pre.failed, blockingNotChecked: pre.blockingNotChecked ?? 0, standardsVersion: run.standardsVersion });
        }
      }
      requireRunsEnabled();
      if (jobs.isActive(p.id)) { throw new HttpError(409, 'job-active', 'This project already has a job running.'); }
      const review = st.plans.find((x) => x.id === run.planId);
      if (!review) { throw new HttpError(409, 'plan-missing', 'The plan for this run no longer exists.'); }
      requireApprovedEngine(p, review);
      const remaining = requireBudget(p, st, run.versionCreatedAt);
      const workspace = requireWorkspace(p);
      const snapshotPath = path.join(state.runDir(p.id, run.id), 'plan.json');
      let snapshot: Plan;
      let resume: GateResumeResult = { reset: [], skipped: [] };
      try {
        snapshot = loadPlan(snapshotPath);
        // A skip completes the gate but sets its shipping dependents Skipped: it never ships.
        resume = prepareGateResume(snapshot, gate.taskId, kind);
      } catch (err) {
        const code = err instanceof GateResumeError ? 'gate-invalid' : 'snapshot-unreadable';
        throw new HttpError(409, code, (err as Error).message);
      }
      snapshot.defaultEngine = p.defaultEngine;
      requirePlanEngines(snapshot);
      writeFileAtomicSync(snapshotPath, JSON.stringify(dehydratePlan(snapshot), null, 2), 0o600);
      spawnRunSegment(p, run, review, remaining, workspace);
      run.status = 'running';
      run.segments += 1;
      if (run.view) {
        // The recorded view mirrors the rewritten snapshot: gate done, its halted dependents
        // pending again — except the shipping work a skip set Skipped.
        const tasks = { ...run.view.tasks, [gate.taskId]: TaskStatus.Completed };
        for (const id of resume.reset) { tasks[id] = TaskStatus.Pending; }
        for (const id of resume.skipped) { tasks[id] = TaskStatus.Skipped; }
        run.view = { ...run.view, tasks, haltReason: null };
        delete run.view.gate;
      }
      run.gateDecisions = [...(run.gateDecisions ?? []), decision];
      delete run.gate;
      delete run.exitCode;
      delete run.endedAt;
      state.save(p.id, st);
      writeAudit(ctx, { action, projectId: p.id, target: gate.name, after: { runId: run.id, taskId: gate.taskId, ...(note ? { note } : {}) }, flags });
      sendJson(ctx.res, 202, { run: runDto(run, ctx.user!, p, st) });
    });
  };
  H['POST /api/projects/:id/runs/:runId/gate/approve'] = decideGate('approve');
  H['POST /api/projects/:id/runs/:runId/gate/reject'] = decideGate('reject');
  H['POST /api/projects/:id/runs/:runId/gate/skip'] = decideGate('skip');

  // ─── Trace & events ───

  H['GET /api/projects/:id/trace'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const plan = state.loadCanonicalPlan(p.id, p.name, p.defaultEngine);
    sendJson(ctx.res, 200, {
      rows: requirementStatuses(plan),
      requirements: latestRequirements(plan).map(({ id, text }) => ({ id, text })),
    });
  };

  H['GET /api/projects/:id/events'] = async (ctx) => {
    const p = getProject(ctx.params.id);
    const key = ctx.session!.sidHash;
    const count = sseCounts.get(key) ?? 0;
    if (count >= MAX_SSE_PER_SESSION) { throw new HttpError(429, 'too-many-streams', 'Too many live connections for this session.'); }
    sseCounts.set(key, count + 1);
    const { res, req } = ctx;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown): void => {
      if (!res.writableEnded) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    };
    res.write('retry: 5000\n\n');
    send('snapshot', { view: jobs.view(p.id), activeJob: jobs.activeKind(p.id) });
    const dispose = jobs.subscribe(p.id, (n: JobNotice) => send(n.type === 'event' ? 'job-event' : 'job-end', n));
    let closed = false;
    // A revoked session (logout, role change, disable, password set) ends its
    // streams at once; expiry and epoch changes are caught at the next heartbeat.
    const endStream = (): void => {
      if (!res.writableEnded) { send('session-ended', {}); res.end(); }
      cleanup();
    };
    const disposeRevoke = sessions.onRevoke((hashes) => { if (hashes.includes(key)) { endStream(); } });
    const hb = setInterval(() => {
      if (!sessions.isLive(key, (id) => users.findById(id))) { endStream(); return; }
      if (!res.writableEnded) { res.write(': hb\n\n'); }
    }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
    const cleanup = (): void => {
      if (closed) { return; }
      closed = true;
      clearInterval(hb);
      dispose();
      disposeRevoke();
      const c = (sseCounts.get(key) ?? 1) - 1;
      if (c <= 0) { sseCounts.delete(key); } else { sseCounts.set(key, c); }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };

  // ─── Router + pipeline ───

  const router = new Router<RouteSpec>();
  for (const r of ROUTES) {
    if (!H[`${r.method} ${r.path}`]) { throw new Error(`No handler for ${r.method} ${r.path}`); }
    router.add(r.method, r.path, r);
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { url = new URL('http://localhost/'); }
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
    for (const [k, v] of Object.entries(securityHeaders({ secure, api: isApi }))) { res.setHeader(k, v); }

    const ctx: Ctx = { req, res, url, params: {}, ip: clientIp(req, config.trustProxy), user: null, session: null, sid: null };
    try {
      const method = req.method ?? 'GET';
      const m = router.match(method, url.pathname);
      if (m.kind === 'not-found' && !isApi && (method === 'GET' || method === 'HEAD')) {
        // Everything outside /api is the static front-end. No session needed: it holds no data.
        staticServer.serve(req, res, url.pathname);
        return;
      }
      if (m.kind === 'not-found') { throw new HttpError(404, 'not-found'); }
      if (m.kind === 'method-not-allowed') { res.setHeader('Allow', m.allowed.join(', ')); throw new HttpError(405, 'method-not-allowed'); }
      const route = m.handler;
      ctx.params = m.params;

      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies[sessionCookieName(secure)];
      if (sid) {
        const s = sessions.get(sid, (id) => users.findById(id));
        if (s) { ctx.session = s; ctx.sid = sid; ctx.user = users.findById(s.userId) ?? null; }
      }

      if (route.auth === 'session') {
        if (!ctx.user || !ctx.session) { throw new HttpError(401, 'unauthenticated', 'Your session ended. Sign in again to continue.'); }
        if (ctx.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(`${route.method} ${route.path}`)) {
          throw new HttpError(403, 'password-change-required', 'Set a new password to continue.');
        }
      }

      if (route.mutating) {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== config.publicOrigin) { throw new HttpError(403, 'bad-origin', 'Cross-origin request refused.'); }
        const token = req.headers['x-csrf-token'];
        const sent = Array.isArray(token) ? token[0] : token;
        const expected = route.auth === 'pre' ? cookies[preAuthCookieName(secure)] : ctx.session?.csrfToken;
        if (!safeEqual(sent, expected)) { throw new HttpError(403, 'csrf', 'Missing or invalid CSRF token.'); }
      }

      if (route.action && !canPerform(actorOf(ctx.user!), route.action)) {
        throw new HttpError(403, 'forbidden', "You don't have permission to do that.");
      }

      await H[`${route.method} ${route.path}`](ctx);
    } catch (err) {
      if (err instanceof LastAdminError) { sendError(res, new HttpError(409, 'last-admin', err.message)); return; }
      if (err instanceof UsernameTakenError) { sendError(res, new HttpError(409, 'username-taken', err.message)); return; }
      if (err instanceof InvalidUserInputError) { sendError(res, new HttpError(400, 'invalid-input', err.message)); return; }
      if (err instanceof UserNotFoundError) { sendError(res, new HttpError(404, 'not-found', err.message)); return; }
      if (err instanceof ProjectInputError) { sendError(res, new HttpError(err.status, err.code, err.message)); return; }
      if (!(err instanceof HttpError) && !(err instanceof ValidationError)) {
        log(`${req.method} ${url.pathname} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
      if (res.headersSent) { if (!res.writableEnded) { res.end(); } return; }
      sendError(res, err);
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`unhandled: ${(err as Error).message}`);
      try { sendError(res, err); } catch { /* response already gone */ }
    });
  });
  // Bound header parsing time and idle sockets (slowloris).
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  return { server, jobs, handle, engines: engineCache, probeEngines };
}
