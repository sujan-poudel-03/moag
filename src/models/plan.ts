// ─── Plan loader / saver — reads and writes .agent-plan.json files ───

import * as fs from 'fs';
import * as path from 'path';
import {
  Plan, PlanFile, PlanFilePlaylist, PlanFileTask,
  Playlist, Task, TaskStatus, EngineId,
  ContextBudget, ValidationProfile, ValidationSettings, ValidationTarget,
} from './types';

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
  if (file.sourceIssues?.length) { plan.sourceIssues = file.sourceIssues; }
  if (file.prdSource) { plan.prdSource = file.prdSource; }
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

/** Strip runtime status from Plan to get a serializable PlanFile */
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
  if (plan.sourceIssues?.length) { result.sourceIssues = plan.sourceIssues; }
  if (plan.prdSource) { result.prdSource = plan.prdSource; }
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
  if (t.sourceIssueNumber !== undefined) { result.sourceIssueNumber = t.sourceIssueNumber; }
  if (t.sourceIssueRepo) { result.sourceIssueRepo = t.sourceIssueRepo; }
  // Only persist non-pending statuses to keep plan files clean
  if (t.status && t.status !== TaskStatus.Pending) {
    result.status = t.status;
  }
  return result;
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
