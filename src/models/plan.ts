// ─── Plan loader / saver — reads and writes .agent-plan.json files ───

import * as fs from 'fs';
import * as path from 'path';
import {
  Plan, PlanFile, PlanFilePlaylist, PlanFileTask,
  Playlist, Task, TaskStatus, EngineId,
} from './types';

/** Generate a short random id */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/** Convert a persisted plan file into the runtime Plan model (adds status fields) */
function hydratePlan(file: PlanFile): Plan {
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
    tasks: p.tasks.map(hydrateTask),
  };
}

function hydrateTask(t: PlanFileTask): Task {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    engine: t.engine,
    cwd: t.cwd,
    files: t.files,
    verifyCommand: t.verifyCommand,
    status: TaskStatus.Pending,
  };
}

/** Strip runtime status from Plan to get a serializable PlanFile */
function dehydratePlan(plan: Plan): PlanFile {
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
    tasks: p.tasks.map(dehydrateTask),
  };
}

function dehydrateTask(t: Task): PlanFileTask {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    engine: t.engine,
    cwd: t.cwd,
    files: t.files,
    verifyCommand: t.verifyCommand,
  };
}

/** Load a plan from a JSON file */
export function loadPlan(filePath: string): Plan {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const file: PlanFile = JSON.parse(raw);
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

/** Create a blank new plan */
export function createEmptyPlan(name: string): Plan {
  return {
    version: '1.0',
    name,
    defaultEngine: 'claude' as EngineId,
    playlists: [],
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
    engine,
    status: TaskStatus.Pending,
  };
}
