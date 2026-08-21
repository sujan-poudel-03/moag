// ─── Plan loader / saver — reads and writes .agent-plan.json files ───

import * as fs from 'fs';
import * as path from 'path';
import {
  Plan, PlanFile, PlanFilePlaylist, PlanFileTask,
  Playlist, Task, TaskStatus, EngineId,
  ContextBudget, PrdVersion, RoleDefinition, RoleId, SandboxConfig, SandboxTarget,
  ValidationProfile, ValidationSettings, ValidationTarget,
} from './types';
import { redactPlanFile } from './plan-redaction';
import { isRoleId, MAX_ROLE_CHARTER_CHARS } from './roles';

const DEFAULT_VALIDATION_TARGETS: ValidationTarget[] = ['all'];
const DEFAULT_VALIDATION_PROFILE: ValidationProfile = 'quick';
const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  discoveryTokens: 12_000,
  analysisTokens: 24_000,
  fixTokens: 16_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Role coercion ───

/**
 * Coerce a persisted role value to a `RoleId`.
 *
 * Deliberately non-throwing: a generator that writes `"role": "senior-backend-engineer"`
 * into a plan file must not be able to stop that plan from loading. An unrecognised value
 * simply becomes undefined, and the next level of the task → playlist → plan chain applies.
 */
function coerceRoleId(raw: unknown): RoleId | undefined {
  return isRoleId(raw) ? raw : undefined;
}

/**
 * Normalize a persisted `customRoles` array.
 *
 * Filters rather than throws — unlike {@link parseValidationTargets}, which rejects the
 * whole file. Role definitions only shape a prompt, so one malformed entry costs that entry
 * and nothing more. Non-records, unknown ids and non-string or empty charters are dropped,
 * each surviving charter is capped, and an array with no survivors returns undefined so the
 * key is simply absent from the plan.
 *
 * `_sourceName` is unused on purpose: it keeps the signature aligned with the other
 * normalizers, which use it to build a throw message this one never produces.
 */
function normalizeCustomRoles(raw: unknown, _sourceName: string): RoleDefinition[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const roles: RoleDefinition[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) { continue; }
    const id = coerceRoleId(entry.id);
    if (!id) { continue; }
    if (typeof entry.charter !== 'string') { continue; }
    const charter = entry.charter.trim().slice(0, MAX_ROLE_CHARTER_CHARS);
    if (!charter) { continue; }
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    roles.push({ id, name, charter });
  }
  return roles.length > 0 ? roles : undefined;
}

function parseValidationTargets(
  rawTargets: unknown,
  fieldPath: string,
  sourceName: string,
): ValidationTarget[] {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new Error(`"${sourceName}" has invalid "${fieldPath}" — expected a non-empty array.`);
  }

  const unique = new Set<ValidationTarget>();
  for (const value of rawTargets) {
    if (value !== 'web' && value !== 'mobile' && value !== 'desktop' && value !== 'all') {
      throw new Error(`"${sourceName}" has invalid "${fieldPath}" value "${String(value)}".`);
    }
    unique.add(value);
  }

  if (unique.has('all')) {
    return ['all'];
  }
  return [...unique];
}

function parseValidationProfile(
  rawProfile: unknown,
  fieldPath: string,
  sourceName: string,
): ValidationProfile {
  if (rawProfile !== 'quick' && rawProfile !== 'pr' && rawProfile !== 'full') {
    throw new Error(
      `"${sourceName}" has invalid "${fieldPath}" value "${String(rawProfile)}" (expected quick/pr/full).`,
    );
  }
  return rawProfile;
}

function parseBudgetTokenValue(rawValue: unknown, fieldPath: string, sourceName: string): number {
  if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue <= 0) {
    throw new Error(`"${sourceName}" has invalid "${fieldPath}" — expected a positive integer.`);
  }
  return rawValue;
}

/**
 * Validate a per-task `timeoutMs` override.
 * The 1000 ms floor is deliberate: the `agentTaskPlayer.taskTimeoutMs` *setting* is
 * floored at 30000 in the runner, but the task field bypasses that resolution, so the
 * only guard against a nonsense value (0, negatives, seconds-instead-of-ms) is here.
 */
function parseTaskTimeoutMs(rawValue: unknown, sourceName: string, taskId: string): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 1000) {
    throw new Error(
      `"${sourceName}" has invalid "tasks[].timeoutMs" for task "${taskId}" — expected an integer >= 1000 (milliseconds).`,
    );
  }
  return rawValue;
}

function normalizePlanValidation(raw: unknown, sourceName: string): ValidationSettings {
  if (raw === undefined) {
    return {
      targets: [...DEFAULT_VALIDATION_TARGETS],
      profile: DEFAULT_VALIDATION_PROFILE,
      contextBudget: { ...DEFAULT_CONTEXT_BUDGET },
    };
  }
  if (!isRecord(raw)) {
    throw new Error(`"${sourceName}" has invalid "validation" — expected an object.`);
  }

  const targets = raw.targets === undefined
    ? [...DEFAULT_VALIDATION_TARGETS]
    : parseValidationTargets(raw.targets, 'validation.targets', sourceName);

  const profile = raw.profile === undefined
    ? DEFAULT_VALIDATION_PROFILE
    : parseValidationProfile(raw.profile, 'validation.profile', sourceName);

  let contextBudget = { ...DEFAULT_CONTEXT_BUDGET };
  if (raw.contextBudget !== undefined) {
    if (!isRecord(raw.contextBudget)) {
      throw new Error(`"${sourceName}" has invalid "validation.contextBudget" — expected an object.`);
    }
    const budget = raw.contextBudget;
    if (budget.discoveryTokens !== undefined) {
      contextBudget.discoveryTokens = parseBudgetTokenValue(
        budget.discoveryTokens,
        'validation.contextBudget.discoveryTokens',
        sourceName,
      );
    }
    if (budget.analysisTokens !== undefined) {
      contextBudget.analysisTokens = parseBudgetTokenValue(
        budget.analysisTokens,
        'validation.contextBudget.analysisTokens',
        sourceName,
      );
    }
    if (budget.fixTokens !== undefined) {
      contextBudget.fixTokens = parseBudgetTokenValue(
        budget.fixTokens,
        'validation.contextBudget.fixTokens',
        sourceName,
      );
    }
  }

  return { targets, profile, contextBudget };
}

/** Validate an optional port value that must be a real TCP port when present. */
function parseSandboxPort(rawValue: unknown, fieldPath: string, sourceName: string): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 1 || rawValue > 65535) {
    throw new Error(`"${sourceName}" has invalid "${fieldPath}" — expected an integer between 1 and 65535.`);
  }
  return rawValue;
}

/**
 * Validate the optional plan-level sandbox configuration.
 *
 * Each target is rebuilt explicitly in `name, cwd, command, port` order rather than
 * spread from the raw object: spreading would carry unknown user keys into the model
 * and write them straight back out on the next save.
 */
function normalizeSandbox(raw: unknown, sourceName: string): SandboxConfig | undefined {
  if (!isRecord(raw)) {
    throw new Error(`"${sourceName}" has invalid "sandbox" — expected an object.`);
  }
  if (raw.targets === undefined && raw.command === undefined) {
    // Also catches the common "target" (singular) typo, which would otherwise load as an empty config.
    throw new Error(`"${sourceName}" has invalid "sandbox" — expected "targets" or "command".`);
  }

  const config: SandboxConfig = {};
  const rawTargets = raw.targets;
  const rawCommand = raw.command;

  if (rawTargets !== undefined) {
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw new Error(`"${sourceName}" has invalid "sandbox.targets" — expected a non-empty array.`);
    }
    config.targets = rawTargets.map((entry: unknown, i: number) => {
      if (!isRecord(entry)) {
        throw new Error(`"${sourceName}" has invalid "sandbox.targets[${i}]" — expected an object.`);
      }
      const name = entry.name;
      const command = entry.command;
      const cwd = entry.cwd;
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`"${sourceName}" has invalid "sandbox.targets[${i}].name" — expected a non-empty string.`);
      }
      if (typeof command !== 'string' || command.length === 0) {
        throw new Error(`"${sourceName}" has invalid "sandbox.targets[${i}].command" — expected a non-empty string.`);
      }
      if (cwd !== undefined && typeof cwd !== 'string') {
        throw new Error(`"${sourceName}" has invalid "sandbox.targets[${i}].cwd" — expected a string.`);
      }
      const port = parseSandboxPort(entry.port, `sandbox.targets[${i}].port`, sourceName);
      // Rebuilt explicitly in key order: name, cwd, command, port.
      const target: SandboxTarget = {
        name,
        ...(cwd !== undefined ? { cwd } : {}),
        command,
        ...(port !== undefined ? { port } : {}),
      };
      return target;
    });
  }

  if (rawCommand !== undefined) {
    if (typeof rawCommand !== 'string' || rawCommand.length === 0) {
      throw new Error(`"${sourceName}" has invalid "sandbox.command" — expected a non-empty string.`);
    }
    config.command = rawCommand;
  }

  const shorthandPort = parseSandboxPort(raw.port, 'sandbox.port', sourceName);
  if (shorthandPort !== undefined) { config.port = shorthandPort; }

  return config;
}

/**
 * Validate the persisted PRD version history.
 *
 * Order is preserved verbatim (plain `.map`, never sorted) — `prdVersions` is an append
 * log and the UI shows the newest snapshot last. Note that the retention cap
 * (`MAX_PRD_VERSIONS` / `MAX_PRD_VERSIONS_CHARS`) is deliberately **not** applied here:
 * a hand-authored file with 50 versions loads all 50 and re-saves all 50. The cap belongs
 * to `appendPrdVersion`, i.e. to the moment a new snapshot is added — never to the loader
 * or the serializer, which stay faithful at any count.
 */
function normalizePrdVersions(raw: unknown, sourceName: string): PrdVersion[] {
  if (!Array.isArray(raw)) {
    throw new Error(`"${sourceName}" has invalid "prdVersions" — expected an array.`);
  }
  return raw.map((entry: unknown, i: number) => {
    if (!isRecord(entry)) {
      throw new Error(`"${sourceName}" has invalid "prdVersions[${i}]" — expected an object.`);
    }
    const version = entry.version;
    const text = entry.text;
    const createdAt = entry.createdAt;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`"${sourceName}" has invalid "prdVersions[${i}].version" — expected a non-empty string.`);
    }
    if (typeof text !== 'string') {
      throw new Error(`"${sourceName}" has invalid "prdVersions[${i}].text" — expected a string.`);
    }
    if (typeof createdAt !== 'string' || createdAt.length === 0) {
      throw new Error(`"${sourceName}" has invalid "prdVersions[${i}].createdAt" — expected a non-empty string.`);
    }
    return { version, text, createdAt };
  });
}

/** Validate the fix-iteration counter — a non-negative integer, where 0 is meaningful. */
function parseFixIterations(rawValue: unknown, sourceName: string): number {
  if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 0) {
    throw new Error(`"${sourceName}" has invalid "fixIterations" — expected an integer >= 0.`);
  }
  return rawValue;
}

function normalizeTaskValidation(raw: unknown, sourceName: string, taskId: string): Task['validation'] {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`"${sourceName}" has invalid "tasks[].validation" for task "${taskId}" — expected an object.`);
  }

  const validation: NonNullable<Task['validation']> = {};
  if (raw.targets !== undefined) {
    validation.targets = parseValidationTargets(raw.targets, 'tasks[].validation.targets', sourceName);
  }
  if (raw.profile !== undefined) {
    validation.profile = parseValidationProfile(raw.profile, 'tasks[].validation.profile', sourceName);
  }
  if (raw.contextBudget !== undefined) {
    if (!isRecord(raw.contextBudget)) {
      throw new Error(
        `"${sourceName}" has invalid "tasks[].validation.contextBudget" for task "${taskId}" — expected an object.`,
      );
    }
    const budget: NonNullable<NonNullable<Task['validation']>['contextBudget']> = {};
    if (raw.contextBudget.discoveryTokens !== undefined) {
      budget.discoveryTokens = parseBudgetTokenValue(
        raw.contextBudget.discoveryTokens,
        'tasks[].validation.contextBudget.discoveryTokens',
        sourceName,
      );
    }
    if (raw.contextBudget.analysisTokens !== undefined) {
      budget.analysisTokens = parseBudgetTokenValue(
        raw.contextBudget.analysisTokens,
        'tasks[].validation.contextBudget.analysisTokens',
        sourceName,
      );
    }
    if (raw.contextBudget.fixTokens !== undefined) {
      budget.fixTokens = parseBudgetTokenValue(
        raw.contextBudget.fixTokens,
        'tasks[].validation.contextBudget.fixTokens',
        sourceName,
      );
    }
    if (Object.keys(budget).length > 0) {
      validation.contextBudget = budget;
    }
  }

  return Object.keys(validation).length > 0 ? validation : undefined;
}

function isDefaultValidationSettings(settings: ValidationSettings): boolean {
  return (
    settings.profile === DEFAULT_VALIDATION_PROFILE &&
    settings.targets.length === 1 &&
    settings.targets[0] === 'all' &&
    settings.contextBudget.discoveryTokens === DEFAULT_CONTEXT_BUDGET.discoveryTokens &&
    settings.contextBudget.analysisTokens === DEFAULT_CONTEXT_BUDGET.analysisTokens &&
    settings.contextBudget.fixTokens === DEFAULT_CONTEXT_BUDGET.fixTokens
  );
}

/** Generate a short random id using crypto when available */
export function generateId(): string {
  try {
    return require('crypto').randomUUID().replace(/-/g, '').substring(0, 12);
  } catch {
    return Math.random().toString(36).substring(2, 10);
  }
}

/** Convert a persisted plan file into the runtime Plan model (adds status fields) */
export function hydratePlan(file: PlanFile, sourceName = 'plan'): Plan {
  const plan: Plan = {
    version: file.version,
    name: file.name,
    description: file.description,
    defaultEngine: file.defaultEngine,
    fallbackEngine: file.fallbackEngine,
    variables: file.variables,
    validation: normalizePlanValidation(file.validation, sourceName),
    playlists: file.playlists.map(p => hydratePlaylist(p, sourceName)),
  };
  const defaultRole = coerceRoleId(file.defaultRole);
  if (defaultRole) { plan.defaultRole = defaultRole; }
  const customRoles = normalizeCustomRoles(file.customRoles, sourceName);
  if (customRoles) { plan.customRoles = customRoles; }
  if (file.sourceIssues?.length) { plan.sourceIssues = file.sourceIssues; }
  if (file.prdSource) { plan.prdSource = file.prdSource; }
  if (file.aiRules) { plan.aiRules = file.aiRules; }
  if (file.prdVersions !== undefined) { plan.prdVersions = normalizePrdVersions(file.prdVersions, sourceName); }
  if (file.fixIterations !== undefined) { plan.fixIterations = parseFixIterations(file.fixIterations, sourceName); }
  if (file.sandbox !== undefined) { plan.sandbox = normalizeSandbox(file.sandbox, sourceName); }
  // Ensure all task/playlist IDs are unique; fix duplicates or missing IDs
  ensureUniqueIds(plan);
  return plan;
}

/** Assign missing IDs and deduplicate any collisions across all tasks and playlists */
function ensureUniqueIds(plan: Plan): void {
  const seen = new Set<string>();
  for (const pl of plan.playlists) {
    if (!pl.id || seen.has(pl.id)) {
      pl.id = generateId();
    }
    seen.add(pl.id);
    for (const task of pl.tasks) {
      if (!task.id || seen.has(task.id)) {
        task.id = generateId();
      }
      seen.add(task.id);
    }
  }
}

function hydratePlaylist(p: PlanFilePlaylist, sourceName: string): Playlist {
  return {
    id: p.id || generateId(),
    name: p.name,
    engine: p.engine,
    role: coerceRoleId(p.role),
    autoplay: p.autoplay ?? true,
    autoplayDelay: p.autoplayDelay,
    parallel: p.parallel,
    aiRules: p.aiRules,
    testPhase: p.testPhase,
    prdContext: p.prdContext,
    tasks: p.tasks.map(t => hydrateTask(t, sourceName)),
  };
}

function hydrateTask(t: PlanFileTask, sourceName: string): Task {
  return {
    id: t.id || generateId(),
    name: t.name,
    prompt: t.prompt,
    type: t.type ?? 'agent',
    engine: t.engine,
    role: coerceRoleId(t.role),
    command: t.command,
    cwd: t.cwd,
    env: t.env,
    inheritEnvFiles: t.inheritEnvFiles,
    scopedVerify: t.scopedVerify,
    files: t.files,
    acceptanceCriteria: t.acceptanceCriteria,
    verifyCommand: t.verifyCommand,
    expectedArtifacts: t.expectedArtifacts,
    ownerNote: t.ownerNote,
    failurePolicy: t.failurePolicy,
    port: t.port,
    readyPattern: t.readyPattern,
    healthCheckUrl: t.healthCheckUrl,
    startupTimeoutMs: t.startupTimeoutMs,
    timeoutMs: parseTaskTimeoutMs(t.timeoutMs, sourceName, t.id || t.name || '<unknown-task>'),
    retryCount: t.retryCount,
    dependsOn: t.dependsOn,
    skipIf: t.skipIf ? { taskId: t.skipIf.taskId, status: t.skipIf.status as TaskStatus } : undefined,
    consensus: t.consensus,
    validation: normalizeTaskValidation(t.validation, sourceName, t.id || t.name || '<unknown-task>'),
    sourceIssueNumber: t.sourceIssueNumber,
    sourceIssueRepo: t.sourceIssueRepo,
    releaseTag: t.releaseTag,
    releaseNotes: t.releaseNotes,
    githubRelease: t.githubRelease,
    monitorSamples: t.monitorSamples,
    monitorIntervalMs: t.monitorIntervalMs,
    failureThreshold: t.failureThreshold,
    incidentRepo: t.incidentRepo,
    incidentLabel: t.incidentLabel,
    status: (t.status as TaskStatus) || TaskStatus.Pending,
  };
}

/**
 * Strip runtime status from Plan to get a serializable PlanFile.
 *
 * Full fidelity, including secrets — variables, AI rules, PRD text and per-task
 * environment variables all survive. That is correct for `savePlan` and for internal plan
 * rewriting, which write back into the user's own workspace. Anything that leaves this
 * machine (clipboard, gist, issue comment) must go through
 * {@link serializePlanForSharing} instead.
 */
export function dehydratePlan(plan: Plan): PlanFile {
  const result: PlanFile = {
    version: plan.version,
    name: plan.name,
    description: plan.description,
    defaultEngine: plan.defaultEngine,
    playlists: plan.playlists.map(dehydratePlaylist),
  };
  if (!isDefaultValidationSettings(plan.validation)) {
    result.validation = {
      targets: plan.validation.targets,
      profile: plan.validation.profile,
      contextBudget: { ...plan.validation.contextBudget },
    };
  }
  if (plan.fallbackEngine) {
    result.fallbackEngine = plan.fallbackEngine;
  }
  if (plan.variables && Object.keys(plan.variables).length > 0) {
    result.variables = plan.variables;
  }
  if (plan.defaultRole) { result.defaultRole = plan.defaultRole; }
  if (plan.customRoles?.length) {
    result.customRoles = plan.customRoles.map(r => ({ id: r.id, name: r.name, charter: r.charter }));
  }
  if (plan.sourceIssues?.length) { result.sourceIssues = plan.sourceIssues; }
  if (plan.prdSource) { result.prdSource = plan.prdSource; }
  if (plan.aiRules) { result.aiRules = plan.aiRules; }
  if (plan.prdVersions?.length) {
    // Faithful at any count — the retention cap lives in appendPrdVersion, not here,
    // so a hand-authored 50-version file re-saves with all 50 intact.
    result.prdVersions = plan.prdVersions.map(v => ({ version: v.version, text: v.text, createdAt: v.createdAt }));
  }
  // typeof, not truthiness: fixIterations === 0 is a real value and must persist as 0.
  if (typeof plan.fixIterations === 'number') { result.fixIterations = plan.fixIterations; }
  if (plan.sandbox && (plan.sandbox.targets?.length || plan.sandbox.command)) {
    // Rebuilt field-by-field in the same key order the loader produces — never emit
    // an empty "targets" array, and never carry unknown keys back out.
    const sandbox: SandboxConfig = {};
    if (plan.sandbox.targets?.length) {
      sandbox.targets = plan.sandbox.targets.map(t => {
        const target: SandboxTarget = {
          name: t.name,
          ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
          command: t.command,
          ...(t.port !== undefined ? { port: t.port } : {}),
        };
        return target;
      });
    }
    if (plan.sandbox.command) { sandbox.command = plan.sandbox.command; }
    if (plan.sandbox.port !== undefined) { sandbox.port = plan.sandbox.port; }
    result.sandbox = sandbox;
  }
  return result;
}

function dehydratePlaylist(p: Playlist): PlanFilePlaylist {
  const result: PlanFilePlaylist = {
    id: p.id,
    name: p.name,
    engine: p.engine,
    autoplay: p.autoplay,
    autoplayDelay: p.autoplayDelay,
    parallel: p.parallel,
    tasks: p.tasks.map(dehydrateTask),
  };
  if (p.role)       { result.role = p.role; }
  if (p.aiRules)    { result.aiRules = p.aiRules; }
  if (p.testPhase)  { result.testPhase = p.testPhase; }
  if (p.prdContext) { result.prdContext = p.prdContext; }
  return result;
}

function dehydrateTask(t: Task): PlanFileTask {
  const result: PlanFileTask = {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    type: t.type,
    engine: t.engine,
    command: t.command,
    cwd: t.cwd,
    env: t.env,
    inheritEnvFiles: t.inheritEnvFiles,
    scopedVerify: t.scopedVerify,
    files: t.files,
    acceptanceCriteria: t.acceptanceCriteria,
    verifyCommand: t.verifyCommand,
    expectedArtifacts: t.expectedArtifacts,
    ownerNote: t.ownerNote,
    failurePolicy: t.failurePolicy,
    port: t.port,
    readyPattern: t.readyPattern,
    healthCheckUrl: t.healthCheckUrl,
    startupTimeoutMs: t.startupTimeoutMs,
    retryCount: t.retryCount,
    dependsOn: t.dependsOn,
    skipIf: t.skipIf ? { taskId: t.skipIf.taskId, status: t.skipIf.status } : undefined,
    consensus: t.consensus,
    releaseTag: t.releaseTag,
    releaseNotes: t.releaseNotes,
    githubRelease: t.githubRelease,
    monitorSamples: t.monitorSamples,
    monitorIntervalMs: t.monitorIntervalMs,
    failureThreshold: t.failureThreshold,
    incidentRepo: t.incidentRepo,
    incidentLabel: t.incidentLabel,
  };
  if (t.validation && Object.keys(t.validation).length > 0) {
    result.validation = {
      targets: t.validation.targets,
      profile: t.validation.profile,
      contextBudget: t.validation.contextBudget,
    };
  }
  if (t.timeoutMs !== undefined) { result.timeoutMs = t.timeoutMs; }
  if (t.sourceIssueNumber !== undefined) { result.sourceIssueNumber = t.sourceIssueNumber; }
  if (t.sourceIssueRepo) { result.sourceIssueRepo = t.sourceIssueRepo; }
  if (t.role) { result.role = t.role; }
  // Only persist non-pending statuses to keep plan files clean
  if (t.status && t.status !== TaskStatus.Pending) {
    result.status = t.status;
  }
  return result;
}

/**
 * Serialize a plan for somewhere other than this machine.
 *
 * Dehydrates the plan, strips every field classified as 'redact' in `plan-redaction.ts`,
 * then formats it. Use this for a clipboard, a gist or an issue comment; use
 * {@link dehydratePlan} + `savePlan` for a local backup, which stays complete.
 *
 * @param opts.stripStatus also remove each task's persisted execution status.
 * @returns the JSON text and the human labels of what was removed (empty when nothing was).
 */
export function serializePlanForSharing(
  plan: Plan,
  opts?: { stripStatus?: boolean },
): { json: string; redacted: string[] } {
  const { file, redacted } = redactPlanFile(dehydratePlan(plan), opts);
  return { json: JSON.stringify(file, null, 2), redacted };
}

/** Load a plan from a JSON file */
export function loadPlan(filePath: string): Plan {
  const fileName = path.basename(filePath);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read "${fileName}" — file not found or not accessible.`);
  }

  if (!raw.trim()) {
    throw new Error(`"${fileName}" is empty. It should contain a valid agent plan JSON.`);
  }

  let file: PlanFile;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new Error(`"${fileName}" contains invalid JSON. Check for syntax errors (missing commas, trailing commas, etc).`);
  }

  if (!file || typeof file !== 'object') {
    throw new Error(`"${fileName}" is not a valid plan — expected a JSON object.`);
  }
  if (!file.version) {
    throw new Error(`"${fileName}" is missing the required "version" field.`);
  }
  if (!Array.isArray(file.playlists)) {
    throw new Error(`"${fileName}" is missing the required "playlists" array.`);
  }
  if (!file.name) {
    throw new Error(`"${fileName}" is missing the required "name" field.`);
  }

  return hydratePlan(file, fileName);
}

/** Save a plan to a JSON file */
export function savePlan(plan: Plan, filePath: string): void {
  const file = dehydratePlan(plan);
  const json = JSON.stringify(file, null, 2);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, json, 'utf-8');
}

// ─── PRD version retention ───

/** Maximum number of PRD snapshots kept in a plan file */
export const MAX_PRD_VERSIONS = 20;

/** Maximum total characters of PRD snapshot text kept in a plan file */
export const MAX_PRD_VERSIONS_CHARS = 400_000;

/**
 * Append a PRD snapshot, trimming the oldest entries until the history fits
 * `MAX_PRD_VERSIONS` and `MAX_PRD_VERSIONS_CHARS`.
 *
 * The entry being added is never dropped, even when it alone exceeds the character
 * ceiling — losing the snapshot the user just asked to save would be worse than
 * exceeding the budget. Trimming always happens from the front (oldest first).
 *
 * @returns the new history and how many older snapshots were removed.
 */
export function appendPrdVersion(
  existing: PrdVersion[] | undefined,
  entry: PrdVersion,
): { versions: PrdVersion[]; dropped: number } {
  const versions: PrdVersion[] = [...(existing ?? []), entry];
  let chars = versions.reduce((sum, v) => sum + v.text.length, 0);
  let dropped = 0;

  while (versions.length > 1 && (versions.length > MAX_PRD_VERSIONS || chars > MAX_PRD_VERSIONS_CHARS)) {
    const removed = versions.shift();
    if (!removed) { break; }
    chars -= removed.text.length;
    dropped++;
  }

  return { versions, dropped };
}

/** Create a new plan with a default playlist ready for tasks */
export function createEmptyPlan(name: string): Plan {
  return {
    version: '1.0',
    name,
    defaultEngine: 'claude' as EngineId,
    validation: normalizePlanValidation(undefined, 'plan'),
    playlists: [createPlaylist('Tasks')],
  };
}

/** Create an empty playlist */
export function createPlaylist(name: string, engine?: EngineId): Playlist {
  return {
    id: generateId(),
    name,
    engine,
    autoplay: true,
    tasks: [],
  };
}

/** Create an empty task */
export function createTask(name: string, prompt: string, engine?: EngineId): Task {
  return {
    id: generateId(),
    name,
    prompt,
    type: 'agent',
    engine,
    status: TaskStatus.Pending,
  };
}
