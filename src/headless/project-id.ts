/**
 * The ONOSOO project ID of a folder, as a run reports it: the closed set of reasons a folder has
 * none, the rule a `project_key` (and its `repo_url`) must pass to be sent, and the scrub context
 * that rule is checked against. Shared by the VS Code command, the dashboard segment and
 * `moag project-id`, so all three show exactly the ID run-meta carries.
 *
 * Free of any `vscode` import (asserted by src/test/unit/server/no-vscode.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RelayStatus } from './host-run-relay';
import { resolveOnosooConfig } from './onosoo-config';
import { keyPassesScrub, RelayScrubContext, repoUrlAsSent, REVOKED_MESSAGE, RUN_META_KEY_MAX, RUN_META_KEY_PREFIX } from './onosoo-relay';
import {
  identityCacheKey, IdentityCacheTimers, ProjectIdentity, ProjectIdentityCache, ProjectIdentityCacheOptions, ProjectIdentityResolution,
  resolveProjectIdentityWithReason,
} from './project-identity';
import { reportingSecretValues } from './task-reporting';
import { createRedactor } from '../utils/redact';

// ─── Reasons ───

/** Every reason a folder has no ONOSOO project ID. Closed: callers switch on all members. */
export const PROJECT_ID_REASONS = [
  'no_folder',
  'not_a_repo',
  'git_unreadable',
  'no_commits',
  'shallow_no_origin',
  'not_sent',
  'timeout',
] as const;

/** One reason a folder has no ONOSOO project ID (the `reason` of `moag project-id --json`). */
export type ProjectIdReason = typeof PROJECT_ID_REASONS[number];

/** The reasons the identity resolver itself can observe. */
export type IdentityAbsenceReason = Extract<ProjectIdReason, 'not_a_repo' | 'git_unreadable' | 'no_commits' | 'shallow_no_origin'>;

/** How long the copy command and `moag project-id` wait for an identity (≤3 git calls of ≤3.5 s). */
export const PROJECT_ID_DEADLINE_MS = 10_000;

/**
 * The phrase of each reason, as it follows "none — " (dashboard), "has no ONOSOO project ID — "
 * (command) and "no ONOSOO project ID — " (CLI). The CLI words `no_folder` itself, with the folder.
 */
export const PROJECT_ID_REASON_PHRASES: Readonly<Record<ProjectIdReason, string>> = {
  no_folder: 'no folder is open',
  not_a_repo: 'not a git repository, or git is not available',
  git_unreadable: 'git could not read this repository',
  no_commits: 'no usable origin remote and no commits yet',
  shallow_no_origin: 'shallow clone with no usable origin remote',
  not_sent: 'its ID would not be sent to ONOSOO',
  timeout: 'could not resolve in time',
};

/** True when `v` is one of {@link PROJECT_ID_REASONS}. */
export function isProjectIdReason(v: unknown): v is ProjectIdReason {
  return typeof v === 'string' && (PROJECT_ID_REASONS as readonly string[]).includes(v);
}

// ─── The rule a key must pass ───

/** A project identity checked against the relay's run-meta rule. */
export type ProjectIdCheck =
  | { ok: true; project_key: string; repo_url: string | null }
  | { ok: false; reason: 'not_sent' };

/**
 * The project ID run-meta would carry for `identity`: accepted iff the key is 1..RUN_META_KEY_MAX
 * characters, has a `git:`/`root:`/`multi:` prefix and passes the relay's redaction and path
 * scrub unchanged. `repo_url` only for a `git:` key whose URL passes {@link repoUrlAsSent}.
 * Never reads `repos`; never throws.
 */
export function projectIdAsSent(identity: ProjectIdentity, ctx: RelayScrubContext): ProjectIdCheck {
  try {
    const key: unknown = identity?.project_key;
    if (typeof key !== 'string' || key.length === 0 || key.length > RUN_META_KEY_MAX) { return { ok: false, reason: 'not_sent' }; }
    if (!RUN_META_KEY_PREFIX.test(key) || keyPassesScrub(key, ctx) !== true) { return { ok: false, reason: 'not_sent' }; }
    const repoUrl = key.startsWith('git:') ? repoUrlAsSent(identity.repo_url, ctx) : null;
    return { ok: true, project_key: key, repo_url: repoUrl };
  } catch {
    return { ok: false, reason: 'not_sent' };
  }
}

/**
 * The scrub context of a run from `cwd`: a redactor over the reporting secrets (the workspace's
 * .env secrets, the engine keys in `env`, and `extras` such as the device key) and `cwd` itself.
 */
export function projectIdScrubContext(cwd: string, env: NodeJS.ProcessEnv, extras: readonly (string | null | undefined)[]): RelayScrubContext {
  const values = extras.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return { redactor: createRedactor(reportingSecretValues(cwd, env, values)), cwd };
}

/** The ONOSOO device key a run from `cwd` would use, or null when this machine is not paired. Never throws. */
export function deviceKeyFor(env: NodeJS.ProcessEnv, cwd: string): string | null {
  try {
    return resolveOnosooConfig({ env, cwd, stderr: () => undefined })?.key ?? null;
  } catch {
    return null;
  }
}

// ─── Reasoned cache ───

/** A {@link ProjectIdentityCache} that also remembers why a folder resolved to no identity. */
export interface ReasonedIdentityCache {
  /** The cache itself, its value type unchanged (the relay and run-meta use it as is). */
  cache: ProjectIdentityCache;
  /** Why `dir` last resolved to null; undefined when it resolved to an identity, or is not known. */
  reasonOf(dir: string): IdentityAbsenceReason | undefined;
}

/** Options of {@link createReasonedIdentityCache}. */
export interface ReasonedIdentityCacheOptions {
  /** Resolves one folder with its reason (default {@link resolveProjectIdentityWithReason}). */
  resolve?: (dir: string) => Promise<ProjectIdentityResolution>;
  /** Most reasons remembered (default 256); the oldest is evicted first. */
  maxEntries?: number;
  cacheOptions?: Omit<ProjectIdentityCacheOptions, 'resolve'>;
}

/**
 * A project identity cache whose lookups record the absence reason beside the cache, keyed like
 * the cache. An evicted reason means "resolve again", never an invented reason. Never throws.
 */
export function createReasonedIdentityCache(opts: ReasonedIdentityCacheOptions = {}): ReasonedIdentityCache {
  const reasons = new Map<string, IdentityAbsenceReason>();
  const maxEntries = Math.max(1, opts.maxEntries ?? 256);
  const resolveFn = opts.resolve ?? ((dir: string) => resolveProjectIdentityWithReason(dir));
  const cache = new ProjectIdentityCache({
    ...(opts.cacheOptions ?? {}),
    resolve: async (dir) => {
      let r: ProjectIdentityResolution;
      try {
        r = await resolveFn(dir);
      } catch {
        r = { identity: null, reason: 'git_unreadable' };
      }
      if (!r || typeof r !== 'object') { r = { identity: null, reason: 'git_unreadable' }; }
      const k = identityCacheKey(dir);
      reasons.delete(k);
      if (r.identity === null) {
        reasons.set(k, r.reason);
        while (reasons.size > maxEntries) {
          const oldest = reasons.keys().next().value;
          if (oldest === undefined) { break; }
          reasons.delete(oldest);
        }
      }
      return r.identity;
    },
  });
  return {
    cache,
    reasonOf: (dir) => {
      try { return reasons.get(identityCacheKey(dir)); } catch { return undefined; }
    },
  };
}

/** Read access to a reasoned identity cache: what is held, why it is null, and a lookup. */
export interface ProjectIdentitySource {
  peek(dir: string): ProjectIdentity | null | undefined;
  reasonOf(dir: string): IdentityAbsenceReason | undefined;
  warm(dir: string, opts?: { priority?: boolean }): Promise<ProjectIdentity | null>;
}

/**
 * What `source` already holds for `dir`: undefined when it was never resolved, or resolved to
 * null without a remembered reason (resolve again in that case).
 */
export function cachedResolution(source: Pick<ProjectIdentitySource, 'peek' | 'reasonOf'>, dir: string): ProjectIdentityResolution | undefined {
  const v = source.peek(dir);
  if (v === undefined) { return undefined; }
  if (v !== null) { return { identity: v, reason: null }; }
  const reason = source.reasonOf(dir);
  return reason ? { identity: null, reason } : undefined;
}

/**
 * Resolve `dir` through `source` (a priority lookup that lands in its cache), falling back to
 * `resolveDirect` when there is no source, or it resolved null without a reason. Never rejects.
 */
export async function resolveFolderIdentity(
  source: ProjectIdentitySource | null,
  dir: string,
  resolveDirect: (dir: string) => Promise<ProjectIdentityResolution> = (d) => resolveProjectIdentityWithReason(d),
): Promise<ProjectIdentityResolution> {
  try {
    if (source) {
      const v = await source.warm(dir, { priority: true });
      if (v) { return { identity: v, reason: null }; }
      const reason = source.reasonOf(dir);
      if (reason) { return { identity: null, reason }; }
    }
    return await resolveDirect(dir);
  } catch {
    return { identity: null, reason: 'git_unreadable' };
  }
}

// ─── Deadline ───

/** How a deadline race ended. A rejected promise is `done` with an undefined value. */
export type DeadlineOutcome<T> = { kind: 'done'; value: T | undefined } | { kind: 'timeout' } | { kind: 'cancelled' };

const DEADLINE_TIMERS: IdentityCacheTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h && typeof h.unref === 'function') { h.unref(); }
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Race `p` against `ms` and an abort signal. Settles exactly once; the timer is cleared and the
 * abort listener removed on every branch. An already-aborted signal is `cancelled` at once.
 * Never rejects. `p` itself is not cancelled: a late result is ignored here.
 */
export function resolveWithDeadline<T>(
  p: Promise<T>,
  ms: number,
  opts: { signal?: AbortSignal; timers?: IdentityCacheTimers } = {},
): Promise<DeadlineOutcome<T>> {
  const timers = opts.timers ?? DEADLINE_TIMERS;
  const signal = opts.signal;
  if (signal?.aborted) {
    void Promise.resolve(p).catch(() => undefined);
    return Promise.resolve({ kind: 'cancelled' });
  }
  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let done = false;
    let timer: unknown;
    const finish = (o: DeadlineOutcome<T>): void => {
      if (done) { return; }
      done = true;
      if (timer !== undefined) { timers.clearTimeout(timer); }
      signal?.removeEventListener('abort', onAbort);
      resolve(o);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });
    signal?.addEventListener('abort', onAbort);
    timer = timers.setTimeout(() => finish({ kind: 'timeout' }), ms);
    void Promise.resolve(p).then(
      (value) => finish({ kind: 'done', value }),
      () => finish({ kind: 'done', value: undefined }),
    );
  });
}

// ─── Dashboard segment model ───

/** The relay statuses under which the dashboard shows the project segment (paired). */
export type PairedRelayStatus = Exclude<RelayStatus, 'none'>;

/** What the dashboard's ONOSOO project segment shows. Never carries a key that would not be sent. */
export type ProjectSegmentModel =
  | { kind: 'hidden' }
  | { kind: 'resolving'; status: PairedRelayStatus; revokedTitle: string }
  | { kind: 'key'; status: PairedRelayStatus; revokedTitle: string; projectKey: string; repoUrl: string | null; firstFolderName: string | null }
  | { kind: 'none'; status: PairedRelayStatus; revokedTitle: string; reason: ProjectIdReason; phrase: string };

/**
 * The segment for a relay status, the first folder's resolution (undefined while resolving) and
 * its check against the run-meta rule. `firstFolderName` is meant only for a multi-root workspace
 * (pass null otherwise). Hidden when unpaired.
 */
export function projectSegmentModel(
  status: RelayStatus,
  resolution: ProjectIdentityResolution | undefined,
  check: ProjectIdCheck | null,
  firstFolderName: string | null,
): ProjectSegmentModel {
  if (status !== 'off' && status !== 'on' && status !== 'revoked') { return { kind: 'hidden' }; }
  const base = { status, revokedTitle: REVOKED_MESSAGE };
  if (resolution === undefined) { return { kind: 'resolving', ...base }; }
  if (resolution.identity === null) {
    return { kind: 'none', ...base, reason: resolution.reason, phrase: PROJECT_ID_REASON_PHRASES[resolution.reason] };
  }
  if (!check?.ok) {
    return { kind: 'none', ...base, reason: 'not_sent', phrase: PROJECT_ID_REASON_PHRASES.not_sent };
  }
  return { kind: 'key', ...base, projectKey: check.project_key, repoUrl: check.repo_url, firstFolderName };
}

// ─── moag project-id ───

/** Printed on stderr for a bad flag or a stray argument. */
export const PROJECT_ID_USAGE = 'Usage: moag project-id [--cwd <dir>] [--json]\n';

/** Injected inputs of {@link cmdProjectId} (tests); every field defaults to the real thing. */
export interface ProjectIdCliDeps {
  /** The env the relay configuration reads (main() passes process.env plus the captured relay variables). */
  env?: NodeJS.ProcessEnv;
  /** The directory `--cwd` is resolved against, and the folder without it. */
  cwd?: string;
  out?(s: string): void;
  err?(s: string): void;
  resolve?: (dir: string) => Promise<ProjectIdentityResolution>;
  deadlineMs?: number;
  timers?: IdentityCacheTimers;
}

/** `--cwd <dir>` and `--json`; null for anything else (a missing value, a positional, an unknown flag). */
function parseProjectIdArgs(argv: readonly string[]): { cwd?: string; json: boolean } | null {
  const r: { cwd?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      r.json = true;
    } else if (a === '--cwd' && i + 1 < argv.length && argv[i + 1].length > 0) {
      r.cwd = argv[++i];
    } else {
      return null;
    }
  }
  return r;
}

/**
 * `moag project-id [--cwd <dir>] [--json]`: print the ONOSOO project ID a run from the folder
 * reports (and its repository URL, when one is sent), checked against the same rule and secrets
 * as `moag run`'s relay. Exit 0 with an ID, 1 without one (the reason on stderr, and in --json),
 * 2 for a usage error. Never prints a key that would not be sent, the repos, or the device key.
 */
export async function cmdProjectId(argv: readonly string[], deps: ProjectIdCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string): void => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string): void => { process.stderr.write(s); });
  const env = deps.env ?? process.env;
  const base = deps.cwd ?? process.cwd();

  const parsed = parseProjectIdArgs(argv);
  if (!parsed) {
    err(PROJECT_ID_USAGE);
    return 2;
  }
  const json = parsed.json;
  const dir = path.resolve(base, parsed.cwd ?? '.');

  const fail = (reason: ProjectIdReason, line?: string): number => {
    if (json) { out(JSON.stringify({ project_key: null, repo_url: null, reason }) + '\n'); }
    err(`moag project-id: no ONOSOO project ID — ${line ?? PROJECT_ID_REASON_PHRASES[reason]}\n`);
    return 1;
  };

  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) { return fail('no_folder', `folder not found: ${dir}`); }

  const resolveFn = deps.resolve ?? ((d: string) => resolveProjectIdentityWithReason(d, { env }));
  let lookup: Promise<ProjectIdentityResolution>;
  try { lookup = Promise.resolve(resolveFn(dir)); } catch { lookup = Promise.resolve({ identity: null, reason: 'git_unreadable' }); }
  const o = await resolveWithDeadline(lookup, deps.deadlineMs ?? PROJECT_ID_DEADLINE_MS, { timers: deps.timers });
  if (o.kind !== 'done') { return fail('timeout'); }
  const r: ProjectIdentityResolution = o.value ?? { identity: null, reason: 'git_unreadable' };
  if (r.identity === null) { return fail(r.reason); }

  const deviceKey = deviceKeyFor(env, dir);
  const check = projectIdAsSent(r.identity, projectIdScrubContext(dir, env, deviceKey ? [deviceKey] : []));
  if (!check.ok) { return fail('not_sent', `${PROJECT_ID_REASON_PHRASES.not_sent} (MOAG's privacy filter would change it)`); }

  if (json) {
    out(JSON.stringify({ project_key: check.project_key, repo_url: check.repo_url, reason: null }) + '\n');
  } else {
    out(check.project_key + '\n');
    if (check.repo_url) { out(check.repo_url + '\n'); }
  }
  return 0;
}
