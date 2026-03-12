// ─── Plan loader / saver — reads and writes .agent-plan.json files ───

import * as fs from 'fs';
import * as path from 'path';
import {
  Plan, PlanFile, PlanFilePlaylist, PlanFileTask,
  Playlist, Task, TaskStatus, EngineId,
} from './types';

/** Generate a short random id using crypto when available */
export function generateId(): string {
  try {
    return require('crypto').randomUUID().replace(/-/g, '').substring(0, 12);
  } catch {
    return Math.random().toString(36).substring(2, 10);
  }
}

/** Convert a persisted plan file into the runtime Plan model (adds status fields) */
export function hydratePlan(file: PlanFile): Plan {
  return {
    version: file.version,
    name: file.name,
    description: file.description,
    defaultEngine: file.defaultEngine,
    playlists: file.playlists.map(hydratePlaylist),
  };
}

function hydratePlaylist(p: PlanFilePlaylist): Playlist {
  return {
    id: p.id,
    name: p.name,
    engine: p.engine,
    autoplay: p.autoplay ?? true,
    autoplayDelay: p.autoplayDelay,
    parallel: p.parallel,
    tasks: p.tasks.map(hydrateTask),
  };
}

function hydrateTask(t: PlanFileTask): Task {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    type: t.type ?? 'agent',
    engine: t.engine,
    command: t.command,
    cwd: t.cwd,
    env: t.env,
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
    status: (t.status as TaskStatus) || TaskStatus.Pending,
  };
}

/** Strip runtime status from Plan to get a serializable PlanFile */
export function dehydratePlan(plan: Plan): PlanFile {
  return {
    version: plan.version,
    name: plan.name,
    description: plan.description,
    defaultEngine: plan.defaultEngine,
    playlists: plan.playlists.map(dehydratePlaylist),
  };
}

function dehydratePlaylist(p: Playlist): PlanFilePlaylist {
  return {
    id: p.id,
    name: p.name,
    engine: p.engine,
    autoplay: p.autoplay,
    autoplayDelay: p.autoplayDelay,
    parallel: p.parallel,
    tasks: p.tasks.map(dehydrateTask),
  };
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
  };
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

  return hydratePlan(file);
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
