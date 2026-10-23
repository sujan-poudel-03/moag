// ─── Remote child: one ONOSOO-started run, as the runner account ───
//
// `moag remote-child` (hidden; not in the usage text). The daemon starts it as the
// low-privilege runner account through `sudo -n -u <runner>` and talks to it over
// stdin/stdout only (sudo closes every other fd):
//
//   stdin   line 1: the JSON job spec — {"op":"probe",…} or {"op":"run",…}
//           then, for a run, exactly `bundleBytes` raw bytes: a git bundle of the
//           project's code (possibly thin, against what the mirror already has)
//           then control lines: {"op":"stop"}. EOF also means stop.
//   stdout  JSONL: the headless events (relayed by the daemon) plus `remote-*`
//           lines only the daemon reads: remote-probe, remote-plan,
//           remote-statuses, remote-cost, remote-bundle-chunk, remote-bundle-end.
//
// The child never sees the device key and never starts a relay. Its engine keys
// arrive in the spec (`engineEnv`). Everything lives under the runner account's
// own ~/.moag-remote (0700):
//
//   repos/<projectId>/   a bare mirror, updated from each inbound bundle
//   worktrees/<runId>/   the run's worktree, on its delivery branch
//   runs/<runId>/        config.json, plan-config.json, headless-state.json, plan-cwd/
//
// At the end the branch's new commits go back to the daemon as a bundle, the
// worktree is removed (never forced: a dirty one is kept and reported), and the
// process tree is killed. Imports nothing that loads `vscode`; the engine core is
// reached only through injected dependencies, after the shim is installed.

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dehydratePlan, hydratePlan } from '../models/plan';
import type { Plan, PlanFile, PlanFileTask } from '../models/types';
import { cwdEscapesWorkspace, stripGeneratedSideEffects } from '../shared/generated-plan';
import { appendShipGate, shippingTaskIds } from '../shared/ship-gate';
import { buildPlanWorkerConfig, buildWorkerConfig } from '../shared/worker-config';
import { addBranchWorktree } from '../runner/worktree';
import { killProcess } from '../utils/process-kill';
import { ENGINE_ENV_KEYS, REMOTE_EXCLUDED_ENGINES } from './remote-isolation';

// ─── Constants ───

export const REMOTE_HOME_DIR = '.moag-remote';
/** No task of a remote run may take longer than this. */
export const REMOTE_TASK_TIMEOUT_MS = 1_800_000;
/** Raw bytes per `remote-bundle-chunk` line (base64 of this is 512 KB). */
export const BUNDLE_CHUNK_BYTES = 384 * 1024;
/** Largest outbound bundle the daemon will take. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** Leftover runs/ and worktrees/ entries older than this are removed at start. */
export const REMOTE_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The ship gate id added to generated plans. */
export const REMOTE_GATE_ID = 'ship-gate';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

// ─── Spec ───

export interface RemoteProbeSpec {
  op: 'probe';
  /** Files the runner account must NOT be able to read. */
  protectedPaths: string[];
  /** Project ids whose mirror shas to report. */
  projects: string[];
  engineEnv: Record<string, string>;
}

export interface RemoteRunSpec {
  op: 'run';
  runId: string;
  projectId: string;
  branch: string;
  branchPrefix: string;
  /** HEAD of the project when the run was accepted. */
  baseSha: string;
  /** Where the branch starts: baseSha for a new run, the branch tip for a continuation. */
  startSha: string;
  engine: string;
  allotment: number;
  goal?: string;
  prd?: string;
  /** A previous run's plan, already transformed for resume (approve/skip/retry). */
  snapshot?: PlanFile;
  /** Raw bundle bytes that follow the spec line on stdin (0 = none). */
  bundleBytes: number;
  engineEnv: Record<string, string>;
  /** Engines this run's plan may name (the daemon's allowed and detected list). Defaults to [engine]. */
  engines?: string[];
  /** How the original run's plan was made: a PRD plan gets ship gates, a goal-only plan does not. */
  planKind?: 'goal' | 'prd';
  /**
   * Resume from the runner mirror's own refs/heads/<this> (a parent whose commits never
   * reached the project). `startSha` is then the project-known base the bundle is cut from.
   */
  resumeFromMirrorBranch?: string;
  /** The parent's branch tip as it reported it; the mirror's must match. */
  expectedTip?: string;
}

/** What a resume says when the runner's copy of the parent's branch is gone or moved. */
export function mirrorBranchGoneMessage(branch: string): string {
  return `This run's commits never reached the project on this PC and the runner's copy of branch ${branch} is gone; start a new run instead.`;
}

export type RemoteChildSpec = RemoteProbeSpec | RemoteRunSpec;

function engineEnvOf(v: unknown): Record<string, string> | null {
  if (v === undefined) { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return null; }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(ENGINE_ENV_KEYS as readonly string[]).includes(k) || typeof val !== 'string') { return null; }
    out[k] = val;
  }
  return out;
}

/** Parse and validate the spec line. Null when malformed. */
export function parseSpec(line: string): RemoteChildSpec | null {
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return null; }
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const engineEnv = engineEnvOf(o.engineEnv);
  if (!engineEnv) { return null; }
  if (o.op === 'probe') {
    const paths = Array.isArray(o.protectedPaths) && o.protectedPaths.every((p) => typeof p === 'string') ? o.protectedPaths as string[] : null;
    const projects = Array.isArray(o.projects) ? (o.projects as unknown[]).filter((p): p is string => typeof p === 'string' && PROJECT_ID.test(p)) : [];
    return paths ? { op: 'probe', protectedPaths: paths, projects, engineEnv } : null;
  }
  if (o.op !== 'run') { return null; }
  const str = (k: string, re?: RegExp): string | null => (typeof o[k] === 'string' && (!re || re.test(o[k] as string)) ? o[k] as string : null);
  const runId = str('runId', SAFE_ID);
  const projectId = str('projectId', PROJECT_ID);
  const branch = str('branch', BRANCH);
  const branchPrefix = str('branchPrefix');
  const baseSha = str('baseSha', SHA);
  const startSha = str('startSha', SHA);
  const engine = str('engine', /^[a-z][a-z0-9-]{0,31}$/);
  if (!runId || !projectId || !branch || branchPrefix === null || !baseSha || !startSha || !engine) { return null; }
  if (!branch.startsWith(branchPrefix) || branch.includes('..')) { return null; }
  if (typeof o.allotment !== 'number' || !(o.allotment > 0) || !Number.isFinite(o.allotment)) { return null; }
  if (typeof o.bundleBytes !== 'number' || !Number.isInteger(o.bundleBytes) || o.bundleBytes < 0 || o.bundleBytes > MAX_BUNDLE_BYTES) { return null; }
  if (o.goal !== undefined && typeof o.goal !== 'string') { return null; }
  if (o.prd !== undefined && typeof o.prd !== 'string') { return null; }
  if (o.snapshot !== undefined && (!o.snapshot || typeof o.snapshot !== 'object')) { return null; }
  if (!o.goal && !o.prd && !o.snapshot) { return null; }
  if (o.engines !== undefined && !(Array.isArray(o.engines) && o.engines.every((e) => typeof e === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(e)))) { return null; }
  return {
    ...(Array.isArray(o.engines) ? { engines: [...o.engines as string[]] } : {}),
    ...(o.planKind === 'goal' || o.planKind === 'prd' ? { planKind: o.planKind } : {}),
    ...(typeof o.resumeFromMirrorBranch === 'string' && BRANCH.test(o.resumeFromMirrorBranch) && !o.resumeFromMirrorBranch.includes('..')
      ? { resumeFromMirrorBranch: o.resumeFromMirrorBranch } : {}),
    ...(typeof o.expectedTip === 'string' && SHA.test(o.expectedTip) ? { expectedTip: o.expectedTip } : {}),
    op: 'run', runId, projectId, branch, branchPrefix, baseSha, startSha, engine, allotment: o.allotment, bundleBytes: o.bundleBytes, engineEnv,
    ...(typeof o.goal === 'string' ? { goal: o.goal } : {}),
    ...(typeof o.prd === 'string' ? { prd: o.prd } : {}),
    ...(o.snapshot ? { snapshot: o.snapshot as PlanFile } : {}),
  };
}

// ─── stdin ───

/** Line- and byte-oriented reader over the child's stdin. */
export class ChildInput {
  private buf = Buffer.alloc(0);
  private ended = false;
  private waiters: Array<() => void> = [];
  private lineListener: ((line: string) => void) | null = null;
  private endListener: (() => void) | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer | string) => {
      this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.wake();
      this.drainLines();
    });
    stream.on('end', () => { this.ended = true; this.wake(); this.endListener?.(); });
    stream.on('error', () => { this.ended = true; this.wake(); this.endListener?.(); });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) { fn(); }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /** The next line (without its newline), or null at EOF. Lines are capped at 64 MiB. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        const line = this.buf.subarray(0, nl).toString('utf-8');
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.ended || this.buf.length > MAX_BUNDLE_BYTES) { return null; }
      await this.wait();
    }
  }

  /** Exactly `n` bytes, or null when stdin ends first. */
  async readBytes(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (this.ended) { return null; }
      await this.wait();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  /** From now on, deliver each further line to `fn` and EOF to `onEnd`. */
  listen(fn: (line: string) => void, onEnd: () => void): void {
    this.lineListener = fn;
    this.endListener = onEnd;
    this.drainLines();
    if (this.ended) { onEnd(); }
  }

  private drainLines(): void {
    if (!this.lineListener) { return; }
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, nl).toString('utf-8');
      this.buf = this.buf.subarray(nl + 1);
      this.lineListener(line);
    }
  }
}

// ─── Config ───

/** The execution config: the server worker's, with this run's allotment as every cap, plus delivery. */
export function buildExecConfig(engine: string, allotment: number, branchPrefix: string): Record<string, Record<string, unknown>> {
  const base = buildWorkerConfig({ defaultEngine: engine as never, versionBudgetUsd: allotment }, allotment, allotment);
  return {
    agentTaskPlayer: {
      ...base.agentTaskPlayer,
      'git.autoCommit': true,
      'git.branchPrefix': branchPrefix,
      parallelPlaylists: 1,
      taskTimeoutMs: REMOTE_TASK_TIMEOUT_MS,
      'engines.claude.autoApprove': true,
      'engines.codex.autoApprove': true,
    },
  };
}

/** The planning config: auto-approve off and the planner tool lockdown (buildPlanWorkerConfig). */
export function buildPlanConfig(engine: string, allotment: number): Record<string, Record<string, unknown>> {
  return buildPlanWorkerConfig({ defaultEngine: engine as never, versionBudgetUsd: allotment }, allotment, allotment) as unknown as Record<string, Record<string, unknown>>;
}

// ─── Generated-plan transforms ───

/**
 * What a generated plan may not keep: side-effect fields are stripped, playlists run
 * one at a time, no task may run longer than {@link REMOTE_TASK_TIMEOUT_MS}, and the
 * last playlist — plus any playlist that ships — ends at a ship gate. Mutates `file`.
 */
export function transformGeneratedPlan(file: PlanFile, opts: { gates?: boolean } = {}): PlanFile {
  const gates = opts.gates !== false;
  const playlists = file.playlists ?? [];
  playlists.forEach((pl, i) => {
    stripGeneratedSideEffects(pl);
    pl.parallel = false;
    for (const t of (pl.tasks ?? []) as PlanFileTask[]) {
      if (t.type === 'manual') { continue; } // a ship gate waits for a person, not a clock
      if (typeof t.timeoutMs !== 'number' || !(t.timeoutMs > 0) || t.timeoutMs > REMOTE_TASK_TIMEOUT_MS) { t.timeoutMs = REMOTE_TASK_TIMEOUT_MS; }
    }
    const ships = shippingTaskIds(pl.tasks ?? []).size > 0;
    // A resumed plan already has its gates: never add a second one.
    const gated = (pl.tasks ?? []).some((t) => t.type === 'manual' && t.id.startsWith(REMOTE_GATE_ID));
    if (gates && !gated && (i === playlists.length - 1 || ships)) { appendShipGate(pl, i === playlists.length - 1 ? REMOTE_GATE_ID : `${REMOTE_GATE_ID}-${i + 1}`); }
  });
  return file;
}

/**
 * Why a plan may not run remotely, or null. Checked on every plan a remote run is
 * given or generates — including a resume snapshot, which lives in a file outside
 * the run: no task `cwd` may leave the worktree, and every engine the plan names
 * (default, fallback, playlist, task) must be one this run may use.
 */
export function reviewRemotePlan(file: PlanFile, allowedEngines: readonly string[]): string | null {
  const allowed = new Set(allowedEngines);
  const named: Array<[string, unknown]> = [['the plan\'s default engine', file.defaultEngine], ['the plan\'s fallback engine', file.fallbackEngine]];
  for (const pl of file.playlists ?? []) {
    named.push([`playlist "${pl.name}"`, pl.engine]);
    for (const t of pl.tasks ?? []) {
      named.push([`task "${t.name}"`, t.engine]);
      if (typeof t.cwd === 'string' && t.cwd.length > 0 && cwdEscapesWorkspace(t.cwd)) {
        return `Task "${String(t.name).slice(0, 80)}" would run outside the project (cwd ${t.cwd.slice(0, 80)}).`;
      }
    }
  }
  for (const [where, engine] of named) {
    if (engine !== undefined && engine !== null && engine !== '' && !allowed.has(String(engine))) {
      return `${where.slice(0, 100)} uses the engine "${String(engine).slice(0, 40)}", which is not available for remote runs on this PC.`;
    }
  }
  return null;
}

// ─── Dependencies ───

/** Runs git; resolves stdout, or null when git fails. */
export type ChildGit = (args: string[], cwd: string) => Promise<string | null>;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The parts of cli.ts and the engine core the child uses. Real ones come from remoteChildMain. */
export interface RemoteChildDeps {
  git: ChildGit;
  input: ChildInput;
  emit(line: Record<string, unknown>): void;
  /** The runner account's home. */
  home: string;
  uid: number;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  /** cli.setup with a memento path outside the worktree. */
  setup(args: any, opts: { mementoPath: string }): Promise<{ runner: any; vscode: any; TaskStatus: any; loadPlan: (p: string) => any }>;
  parseArgs(argv: string[]): any;
  wireEvents(runner: any): any;
  wireTaskReporting(runner: any, cwd: string): () => void;
  runAfterWiring(args: any, ctx: any, plan: Plan, planPath: string, events: any, extra: { branch: string }): Promise<number>;
  buildPromptPlan(goal: string, engine: string): Plan;
  /** Run one planning call on `engine` with cwd = the empty plan dir. */
  runPlanner(engine: string, prompt: string, cwd: string, signal: AbortSignal): Promise<{ stdout: string; exitCode: number; stderr?: string }>;
  buildFullPlanPrompt(prdText: string): string;
  parseGeneratedPlan(stdout: string): { ok: true; plan: Plan } | { ok: false; error: string };
  detectEngines(): Promise<string[]>;
  costLedger: {
    onRecord(fn: (e: { estimatedCostUsd: number; engineId: string }) => void): () => void;
    onUnreported(fn: (e: { engineId: string }) => void): () => void;
  };
  /** The shim's __setWorkspaceRoot: also drops its cached config. */
  setWorkspaceRoot(root: string): void;
  /** Arm the after-stop watchdog (kill the tree and exit if the run does not settle). */
  armWatchdog(): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Helpers ───

function mkdir700(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows */ }
}

/** True when this process can open `p` for reading. */
function canRead(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Remove runs/* and worktrees/* entries older than the prune age. */
function pruneOld(home: string, now: number): void {
  for (const sub of ['runs', 'worktrees']) {
    const dir = path.join(home, sub);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (now - fs.statSync(p).mtimeMs > REMOTE_PRUNE_AGE_MS) { fs.rmSync(p, { recursive: true, force: true }); }
      } catch { /* best effort */ }
    }
  }
}

/** Remove every MOAG_* (except MOAG_CONFIG_PATH) and CI from `env`; copy in the engine keys. */
export function prepareChildEnv(env: NodeJS.ProcessEnv, engineEnv: Record<string, string>): void {
  for (const k of Object.keys(env)) {
    if (k === 'CI' || (k.startsWith('MOAG_') && k !== 'MOAG_CONFIG_PATH')) { delete env[k]; }
  }
  for (const [k, v] of Object.entries(engineEnv)) {
    if ((ENGINE_ENV_KEYS as readonly string[]).includes(k)) { env[k] = v; }
  }
}

// ─── Probe ───

async function runProbe(spec: RemoteProbeSpec, deps: RemoteChildDeps): Promise<number> {
  prepareChildEnv(deps.env, spec.engineEnv);
  const unreadable: Record<string, boolean> = {};
  for (const p of spec.protectedPaths) { unreadable[p] = !canRead(p); }
  let engines: string[] = [];
  try { engines = await deps.detectEngines(); } catch { engines = []; }
  if (spec.engineEnv.ANTHROPIC_API_KEY) { engines.push('anthropic'); }
  engines = [...new Set(engines)].filter((e) => !REMOTE_EXCLUDED_ENGINES.has(e));
  const mirrors: Record<string, string[]> = {};
  for (const id of spec.projects) {
    const mirror = path.join(deps.home, REMOTE_HOME_DIR, 'repos', id);
    if (!fs.existsSync(mirror)) { continue; }
    const out = await deps.git(['for-each-ref', '--format=%(objectname)'], mirror);
    if (out) { mirrors[id] = [...new Set(out.split('\n').map((s) => s.trim()).filter((s) => SHA.test(s)))].slice(0, 100); }
  }
  deps.emit({ event: 'remote-probe', uid: deps.uid, unreadable, engines, mirrors, home: deps.home });
  return 0;
}

// ─── Run ───

/** Statuses of every task, for `remote-statuses`. */
function statusesOf(plan: Plan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pl of plan.playlists) { for (const t of pl.tasks) { out[t.id] = t.status; } }
  return out;
}

/** Bring the inbound bundle into the mirror. Returns an error message, or null. */
async function updateMirror(spec: RemoteRunSpec, mirror: string, bundle: Buffer, runDir: string, deps: RemoteChildDeps): Promise<string | null> {
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    mkdir700(path.dirname(mirror));
    if ((await deps.git(['init', '--bare', '-q', mirror], path.dirname(mirror))) === null) { return 'The runner copy of the project could not be created.'; }
  }
  if (bundle.length > 0) {
    const file = path.join(runDir, 'in.bundle');
    fs.writeFileSync(file, bundle, { mode: 0o600 });
    const heads = await deps.git(['bundle', 'list-heads', file], mirror);
    if (heads === null) { return 'The project\'s code arrived damaged (bad bundle).'; }
    const refspecs: string[] = [];
    for (const l of heads.split('\n')) {
      const ref = l.trim().split(/\s+/)[1];
      if (ref === 'HEAD') { refspecs.push('+HEAD:refs/moag/base'); }
      else if (ref && ref.startsWith('refs/heads/') && BRANCH.test(ref.slice(11))) { refspecs.push(`+${ref}:refs/remotes/origin/${ref.slice(11)}`); }
    }
    if (refspecs.length > 0 && (await deps.git(['fetch', '--no-tags', '-q', file, ...refspecs], mirror)) === null) {
      return 'The project\'s code could not be brought into the runner copy.';
    }
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  const exclude = path.join(mirror, 'info', 'exclude');
  try {
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf-8') : '';
    if (!text.split('\n').includes('.moag/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.moag/\n`);
    }
  } catch { /* the plan's own .moag is still never committed by delivery */ }
  if ((await deps.git(['cat-file', '-e', `${spec.startSha}^{commit}`], mirror)) === null) {
    return 'The commit the run starts from is not in the runner copy.';
  }
  return null;
}

/** Build the plan the run executes (resume snapshot, goal, or PRD). Throws a readable Error. */
async function buildRunPlan(spec: RemoteRunSpec, runDir: string, wt: string, execConfigPath: string, signal: AbortSignal, deps: RemoteChildDeps): Promise<Plan> {
  const allowed = spec.engines && spec.engines.length > 0 ? spec.engines : [spec.engine];
  if (spec.snapshot) {
    // A goal-only run never had a ship gate; resuming it must not add one.
    const file = transformGeneratedPlan(JSON.parse(JSON.stringify(spec.snapshot)) as PlanFile, { gates: spec.planKind !== 'goal' });
    const refusal = reviewRemotePlan(file, allowed);
    if (refusal) { throw new Error(refusal); }
    return hydratePlan(file, 'remote snapshot');
  }
  if (!spec.prd) { return deps.buildPromptPlan(spec.goal as string, spec.engine); }

  // Planning: no tools pre-approved, cwd = an empty dir (no repo-shipped engine config loads).
  const planCwd = path.join(runDir, 'plan-cwd');
  mkdir700(planCwd);
  const planConfigPath = path.join(runDir, 'plan-config.json');
  fs.writeFileSync(planConfigPath, JSON.stringify(buildPlanConfig(spec.engine, spec.allotment), null, 2), { mode: 0o600 });
  deps.env.MOAG_CONFIG_PATH = planConfigPath;
  deps.setWorkspaceRoot(planCwd);
  try {
    const prdText = spec.goal ? `Goal: ${spec.goal}\n\n${spec.prd}` : spec.prd;
    const res = await deps.runPlanner(spec.engine, deps.buildFullPlanPrompt(prdText), planCwd, signal);
    if (signal.aborted) { throw new Error('The run was stopped while its plan was being written.'); }
    if (res.exitCode !== 0) { throw new Error(`The plan could not be generated (${spec.engine} exited ${res.exitCode}).`); }
    const parsed = deps.parseGeneratedPlan(res.stdout);
    if (!parsed.ok) { throw new Error(parsed.error); }
    const file = transformGeneratedPlan(dehydratePlan(parsed.plan));
    if (!file.defaultEngine) { file.defaultEngine = spec.engine as never; }
    const refusal = reviewRemotePlan(file, allowed);
    if (refusal) { throw new Error(refusal); }
    return hydratePlan(file, 'generated plan');
  } finally {
    deps.env.MOAG_CONFIG_PATH = execConfigPath;
    deps.setWorkspaceRoot(wt);
  }
}

/** Send the branch's new commits back as chunked base64 lines. */
async function sendBundle(spec: RemoteRunSpec, mirror: string, runDir: string, deps: RemoteChildDeps): Promise<void> {
  // The branch tip as it stands in the runner's mirror: a later resume checks it is still there.
  const tipOut = await deps.git(['rev-parse', '--verify', '--quiet', `refs/heads/${spec.branch}^{commit}`], mirror);
  const tip = tipOut && SHA.test(tipOut.trim()) ? { tip: tipOut.trim() } : {};
  // Cut from spec.startSha, which the project knows: a resume from the mirror then carries
  // the parent's commits too, so the import's prerequisite is met.
  const count = await deps.git(['rev-list', '--count', `${spec.startSha}..refs/heads/${spec.branch}`], mirror);
  if (count === null || Number(count.trim()) === 0) {
    deps.emit({ event: 'remote-bundle-end', bytes: 0, sha256: null, ...tip });
    return;
  }
  const file = path.join(runDir, 'out.bundle');
  if ((await deps.git(['bundle', 'create', file, `refs/heads/${spec.branch}`, '--not', spec.startSha], mirror)) === null) {
    deps.emit({ event: 'remote-bundle-end', bytes: 0, sha256: null, error: 'The run\'s commits could not be bundled.', ...tip });
    return;
  }
  let data: Buffer;
  try { data = fs.readFileSync(file); } catch {
    deps.emit({ event: 'remote-bundle-end', bytes: 0, sha256: null, error: 'The run\'s bundle could not be read.', ...tip });
    return;
  }
  if (data.length > MAX_BUNDLE_BYTES) {
    deps.emit({ event: 'remote-bundle-end', bytes: data.length, sha256: null, error: 'The run\'s commits are larger than 64 MB and were not sent.', ...tip });
    return;
  }
  for (let off = 0; off < data.length; off += BUNDLE_CHUNK_BYTES) {
    deps.emit({ event: 'remote-bundle-chunk', data: data.subarray(off, off + BUNDLE_CHUNK_BYTES).toString('base64') });
  }
  deps.emit({ event: 'remote-bundle-end', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...tip });
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

async function runRun(spec: RemoteRunSpec, deps: RemoteChildDeps): Promise<number> {
  const home = path.join(deps.home, REMOTE_HOME_DIR);
  mkdir700(home);
  pruneOld(home, (deps.now ?? Date.now)());
  const mirror = path.join(home, 'repos', spec.projectId);
  const wt = path.join(home, 'worktrees', spec.runId);
  const runDir = path.join(home, 'runs', spec.runId);
  mkdir700(path.join(home, 'repos'));
  mkdir700(path.join(home, 'worktrees'));
  mkdir700(runDir);

  // Stop: from the control channel or EOF, at any point from here on.
  const planAbort = new AbortController();
  let stopped = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runner: any = null;
  const requestStop = (): void => {
    if (stopped) { return; }
    stopped = true;
    planAbort.abort();
    try { runner?.stop(); } catch { /* already stopping */ }
    deps.armWatchdog();
  };

  const bundle = spec.bundleBytes > 0 ? await deps.input.readBytes(spec.bundleBytes) : Buffer.alloc(0);
  deps.input.listen((line) => {
    try { if ((JSON.parse(line) as { op?: unknown }).op === 'stop') { requestStop(); } } catch { /* not a control line */ }
  }, requestStop);
  // Before anything that spends: a failure here tells the daemon nothing was spent.
  const failEarly = (message: string): number => {
    deps.emit({ event: 'error', message });
    deps.emit({ event: 'remote-no-spend' });
    return 2;
  };
  if (!bundle) { return failEarly('The project\'s code did not arrive.'); }

  const mirrorError = await updateMirror(spec, mirror, bundle, runDir, deps);
  if (mirrorError) { return failEarly(mirrorError); }
  let startPoint = spec.startSha;
  if (spec.resumeFromMirrorBranch) {
    // The parent's commits only exist here: continue from the mirror's own branch.
    const out = await deps.git(['rev-parse', '--verify', '--quiet', `refs/heads/${spec.resumeFromMirrorBranch}^{commit}`], mirror);
    const tip = out ? out.trim() : '';
    if (!SHA.test(tip) || (spec.expectedTip !== undefined && tip !== spec.expectedTip)) {
      return failEarly(mirrorBranchGoneMessage(spec.resumeFromMirrorBranch));
    }
    startPoint = tip;
  }
  const added = await addBranchWorktree(mirror, wt, spec.branch, startPoint, deps.git);
  const head = added.ok ? await deps.git(['symbolic-ref', '--short', 'HEAD'], wt) : null;
  if (!added.ok || (head ?? '').trim() !== spec.branch) {
    return failEarly(`The run's worktree could not be prepared on ${spec.branch}.`);
  }

  let code = 2;
  let offRecord: (() => void) | null = null;
  let offUnreported: (() => void) | null = null;
  try {
    // Exec config and environment, then the engine core rooted at the worktree.
    const execConfigPath = path.join(runDir, 'config.json');
    fs.writeFileSync(execConfigPath, JSON.stringify(buildExecConfig(spec.engine, spec.allotment, spec.branchPrefix), null, 2), { mode: 0o600 });
    deps.env.MOAG_CONFIG_PATH = execConfigPath;
    prepareChildEnv(deps.env, spec.engineEnv);
    const args = deps.parseArgs(['run', '--cwd', wt]);
    // The shim was installed before the worktree existed: root it (and its config) here.
    deps.setWorkspaceRoot(wt);
    const ctx = await deps.setup(args, { mementoPath: path.join(runDir, 'headless-state.json') });
    runner = ctx.runner;
    // Nothing is written into the worktree on run start (no local standards base).
    runner.setRunStartHook?.(null);
    // Every engine call from here on — planning included — is reported to the daemon's ledger.
    offRecord = deps.costLedger.onRecord((e) => deps.emit({ event: 'remote-cost', usd: e.estimatedCostUsd, engine: e.engineId }));
    offUnreported = deps.costLedger.onUnreported((e) => deps.emit({ event: 'remote-cost', unreported: true, engine: e.engineId }));
    if (stopped) { return 2; }

    let plan: Plan;
    try {
      plan = await buildRunPlan(spec, runDir, wt, execConfigPath, planAbort.signal, deps);
    } catch (err) {
      deps.emit({ event: 'error', message: err instanceof Error ? err.message : String(err) });
      return 2;
    }
    deps.emit({ event: 'remote-plan', plan: dehydratePlan(plan) });
    runner.setDeliveryBranch(spec.branch, { required: true });

    const events = deps.wireEvents(runner);
    const unwireReporting = deps.wireTaskReporting(runner, wt);
    const reportStatuses = (): void => deps.emit({ event: 'remote-statuses', statuses: statusesOf(plan) });
    runner.on('task-completed', reportStatuses);
    runner.on('task-failed', reportStatuses);
    let delivered = false;
    const onState = (s: string): void => { if (s === 'playing') { delivered = true; } };
    runner.on('state-changed', onState);
    try {
      if (stopped) { return 2; }
      code = await deps.runAfterWiring(args, ctx, plan, '<remote>', events, { branch: spec.branch });
    } finally {
      reportStatuses();
      runner.off?.('task-completed', reportStatuses);
      runner.off?.('task-failed', reportStatuses);
      runner.off?.('state-changed', onState);
      unwireReporting();
    }
    if (!delivered && !stopped) {
      deps.emit({ event: 'error', message: `The run could not deliver to ${spec.branch}; no task ran.` });
      code = 2;
    }
    return code;
  } finally {
    offRecord?.();
    offUnreported?.();
    await sendBundle(spec, mirror, runDir, deps);
    if ((await deps.git(['worktree', 'remove', wt], mirror)) === null) {
      deps.emit({ event: 'warning', message: 'The run left uncommitted changes in its worktree, which was kept on the build machine.' });
    }
    await deps.git(['worktree', 'prune'], mirror);
  }
}

/** Run one remote job. Never throws: a failure is an `error` line and exit 2. */
export async function runRemoteChild(spec: RemoteChildSpec, deps: RemoteChildDeps): Promise<number> {
  try {
    return spec.op === 'probe' ? await runProbe(spec, deps) : await runRun(spec, deps);
  } catch (err) {
    deps.emit({ event: 'error', message: err instanceof Error ? err.message : String(err) });
    return 2;
  }
}

// ─── Entry ───

const GIT_TIMEOUT_MS = 10 * 60_000;

/** Spawn git, resolving stdout or null; bounded by a timeout that kills the process. */
export const spawnGit: ChildGit = (args, cwd) => new Promise((resolve) => {
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch {
    resolve(null);
    return;
  }
  const chunks: Buffer[] = [];
  let settled = false;
  const finish = (v: string | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
  const timer = setTimeout(() => { killProcess(proc); finish(null); }, GIT_TIMEOUT_MS);
  proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
  proc.stderr?.on('data', () => undefined);
  proc.on('error', () => finish(null));
  proc.on('close', (c) => finish(c === 0 ? Buffer.concat(chunks).toString('utf-8') : null));
});

/* eslint-disable @typescript-eslint/no-var-requires */
/** `moag remote-child`: read the spec from stdin, run it, exit. */
export async function remoteChildMain(): Promise<number> {
  const { guardParentPipes, armDisconnectWatchdog } = require('../shared/worker-pipes');
  guardParentPipes(process.stdout, process.stderr);
  const write = (line: Record<string, unknown>): void => {
    try { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n'); } catch { /* parent gone */ }
  };
  const killTree = (): void => { try { require('../utils/process-kill').killOwnProcessTree(); } catch { /* exiting anyway */ } };
  const input = new ChildInput(process.stdin);
  const first = await input.readLine();
  const spec = first === null ? null : parseSpec(first);
  if (!spec) { write({ event: 'error', message: 'Malformed remote job.' }); return 2; }
  if (process.env.CI) { delete process.env.CI; }

  const home = os.homedir();
  const { installVscodeShim } = require('./install-shim');
  installVscodeShim(path.join(home, REMOTE_HOME_DIR));
  const cli = require('./cli');
  const shim = require('./vscode-shim');
  let watchdogArmed = false;
  const deps: RemoteChildDeps = {
    git: spawnGit,
    input,
    emit: write,
    home,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    env: process.env,
    setup: (args, opts) => cli.setup(args, opts),
    parseArgs: cli.parseArgs,
    wireEvents: cli.wireEvents,
    wireTaskReporting: (runner, cwd) => {
      const { wireTaskReporting, reportingSecretValues } = require('./task-reporting');
      const { createRedactor } = require('../utils/redact');
      return wireTaskReporting(runner, { cwd, emit: write, makeRedactor: () => createRedactor(reportingSecretValues(cwd, process.env)) });
    },
    runAfterWiring: (args, ctx, plan, planPath, events, extra) => cli.runAfterWiring(args, ctx, plan, planPath, events, extra),
    buildPromptPlan: (goal, engine) => cli.buildPromptPlan(goal, engine),
    runPlanner: (engine, prompt, cwd, signal) => require('../adapters/index').getEngine(engine).runTask({ prompt, cwd, signal, costLabel: 'plan-generation' }),
    buildFullPlanPrompt: (prd) => require('../runner/prd-plan').buildFullPlanPrompt(prd),
    parseGeneratedPlan: (stdout) => require('../runner/prd-plan').parseGeneratedPlan(stdout),
    detectEngines: async () => (await require('../engine-detection').detectEngines()).available,
    costLedger: require('../utils/cost-ledger').costLedger,
    setWorkspaceRoot: (root) => shim.__setWorkspaceRoot(root),
    armWatchdog: () => {
      if (watchdogArmed) { return; }
      watchdogArmed = true;
      armDisconnectWatchdog({ killTree, exit: (c: number) => process.exit(c) });
    },
  };
  const code = await runRemoteChild(spec, deps);
  killTree();
  return code;
}
/* eslint-enable @typescript-eslint/no-var-requires */
