// ─── Plan redaction — what may leave this machine ───
//
// A plan file carries secrets: template variables (tokens, hostnames), the AI rules the
// team wrote, the PRD the plan was generated from, and per-task environment variables.
// None of that belongs in a clipboard paste, a gist, or an issue comment.
//
// The three disclosure tables below are `Record<keyof …, Disclosure>` on purpose: a new
// field on PlanFile / PlanFilePlaylist / PlanFileTask will not compile until somebody
// classifies it as 'share' or 'redact'. That is the whole point — a field nobody
// classified is a field that leaks by default, and this makes leaking the loud option.

import { PlanFile, PlanFilePlaylist, PlanFileTask } from './types';

/** Whether a field may leave the machine or must be stripped first */
export type Disclosure = 'share' | 'redact';

/**
 * A PlanFile that has been through {@link redactPlanFile}.
 * The brand is documentation-grade — it exists so a reader (and a reviewer) can see at a
 * glance which side of the boundary a value is on.
 */
export type ShareablePlanFile = PlanFile & { readonly __shareable: true };

// ─── Disclosure tables ───

export const PLAN_FILE_DISCLOSURE: Record<keyof PlanFile, Disclosure> = {
  version: 'share',
  name: 'share',
  description: 'share',
  defaultEngine: 'share',
  fallbackEngine: 'share',
  variables: 'redact',
  sourceIssues: 'share',
  prdSource: 'redact',
  aiRules: 'redact',
  prdVersions: 'redact',
  fixIterations: 'share',
  sandbox: 'share',
  validation: 'share',
  playlists: 'share',
};

export const PLAYLIST_DISCLOSURE: Record<keyof PlanFilePlaylist, Disclosure> = {
  id: 'share',
  name: 'share',
  engine: 'share',
  autoplay: 'share',
  autoplayDelay: 'share',
  parallel: 'share',
  aiRules: 'redact',
  testPhase: 'share',
  // prdContext carries up to 4000 chars of verbatim PRD per playlist — without this it
  // would be the sole remaining PRD carrier in a shared plan.
  prdContext: 'redact',
  tasks: 'share',
};

export const TASK_DISCLOSURE: Record<keyof PlanFileTask, Disclosure> = {
  id: 'share',
  name: 'share',
  prompt: 'share',
  type: 'share',
  engine: 'share',
  command: 'share',
  cwd: 'share',
  env: 'redact',
  inheritEnvFiles: 'share',
  scopedVerify: 'share',
  files: 'share',
  acceptanceCriteria: 'share',
  verifyCommand: 'share',
  expectedArtifacts: 'share',
  ownerNote: 'redact',
  failurePolicy: 'share',
  port: 'share',
  readyPattern: 'share',
  healthCheckUrl: 'share',
  startupTimeoutMs: 'share',
  timeoutMs: 'share',
  retryCount: 'share',
  dependsOn: 'share',
  skipIf: 'share',
  consensus: 'share',
  validation: 'share',
  sourceIssueNumber: 'share',
  sourceIssueRepo: 'share',
  releaseTag: 'share',
  releaseNotes: 'share',
  githubRelease: 'share',
  monitorSamples: 'share',
  monitorIntervalMs: 'share',
  failureThreshold: 'share',
  incidentRepo: 'share',
  incidentLabel: 'share',
  status: 'share',
};

// ─── Human labels ───
// Deliberately coarse: the caller shows these in a notification, so a 200-task plan must
// say "task environment variables" once, not once per task.

const PLAN_FILE_LABELS: Record<string, string> = {
  variables: 'variables',
  prdSource: 'PRD text',
  aiRules: 'plan rules',
  prdVersions: 'PRD version history',
};

const PLAYLIST_LABELS: Record<string, string> = {
  aiRules: 'plan rules',
  prdContext: 'playlist PRD context',
};

const TASK_LABELS: Record<string, string> = {
  env: 'task environment variables',
  ownerNote: 'owner notes',
};

/** True when a value actually carries something worth claiming we removed. */
function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) { return false; }
  if (typeof value === 'string') { return value.length > 0; }
  if (Array.isArray(value)) { return value.length > 0; }
  if (typeof value === 'object') { return Object.keys(value as object).length > 0; }
  return true;
}

/**
 * Delete every 'redact' key from `bag`, recording a human label only for the keys that
 * held real content. An empty `env: {}` is still removed (it should never reach a shared
 * file) but is not reported, so the notification never claims a phantom removal.
 */
function applyDisclosure(
  bag: Record<string, unknown>,
  table: Record<string, Disclosure>,
  labels: Record<string, string>,
  redacted: Set<string>,
): void {
  for (const key of Object.keys(table)) {
    if (table[key] !== 'redact') { continue; }
    if (!(key in bag)) { continue; }
    if (hasContent(bag[key])) {
      redacted.add(labels[key] ?? key);
    }
    delete bag[key];
  }
}

/**
 * Produce a copy of `file` with every 'redact' field removed, at plan, playlist and task
 * level.
 *
 * The clone goes through `JSON.parse(JSON.stringify(...))`, which both isolates the copy
 * (a shallow copy would delete `env` off the live Task objects the runner is about to
 * execute) and drops `undefined`-valued keys — exactly what `savePlan` writes.
 *
 * @param opts.stripStatus also remove each task's persisted execution status.
 * @returns the shareable file and the de-duplicated human labels of what was removed.
 */
export function redactPlanFile(
  file: PlanFile,
  opts?: { stripStatus?: boolean },
): { file: ShareablePlanFile; redacted: string[] } {
  const clone = JSON.parse(JSON.stringify(file)) as PlanFile;
  const redacted = new Set<string>();

  applyDisclosure(
    clone as unknown as Record<string, unknown>,
    PLAN_FILE_DISCLOSURE as Record<string, Disclosure>,
    PLAN_FILE_LABELS,
    redacted,
  );

  for (const playlist of clone.playlists ?? []) {
    applyDisclosure(
      playlist as unknown as Record<string, unknown>,
      PLAYLIST_DISCLOSURE as Record<string, Disclosure>,
      PLAYLIST_LABELS,
      redacted,
    );
    for (const task of playlist.tasks ?? []) {
      const bag = task as unknown as Record<string, unknown>;
      applyDisclosure(bag, TASK_DISCLOSURE as Record<string, Disclosure>, TASK_LABELS, redacted);
      if (opts?.stripStatus) {
        delete bag.status;
      }
    }
  }

  return { file: clone as ShareablePlanFile, redacted: [...redacted] };
}
