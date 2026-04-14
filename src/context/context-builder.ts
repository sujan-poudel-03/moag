// ─── Context Builder — enriches task prompts with plan-aware context ───

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Plan, Playlist, Task, TaskStatus, HistoryEntry } from '../models/types';
import { HistoryStore } from '../history/store';

/** Toggles and limits for context injection */
export interface ContextSettings {
  enabled: boolean;
  planOverview: boolean;
  priorTaskOutputs: boolean;
  allPriorOutputs: boolean;
  projectState: boolean;
  changedFiles: boolean;
  relevantFiles: boolean;
  cumulativeProgress: boolean;
  maxContextChars: number;
  maxOutputPerTask: number;
  maxFileContextChars: number;
  fileTreeDepth: number;
  maxPriorTasks: number;
}

/** Arguments passed to buildContext */
export interface ContextOptions {
  plan: Plan;
  playlist: Playlist;
  task: Task;
  cwd: string;
  historyStore: HistoryStore;
  settings: ContextSettings;
}

/** Read context settings from VS Code configuration */
export function getContextSettings(): ContextSettings {
  const cfg = vscode.workspace.getConfiguration('agentTaskPlayer.context');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    planOverview: cfg.get<boolean>('planOverview', true),
    priorTaskOutputs: cfg.get<boolean>('priorTaskOutputs', true),
    allPriorOutputs: cfg.get<boolean>('allPriorOutputs', false),
    projectState: cfg.get<boolean>('projectState', false),
    changedFiles: cfg.get<boolean>('changedFiles', true),
    cumulativeProgress: cfg.get<boolean>('cumulativeProgress', true),
    relevantFiles: cfg.get<boolean>('relevantFiles', true),
    maxContextChars: Math.max(cfg.get<number>('maxContextChars', 12000), 1000),
    maxOutputPerTask: Math.max(cfg.get<number>('maxOutputPerTask', 1500), 500),
    maxFileContextChars: Math.max(cfg.get<number>('maxFileContextChars', 6000), 1000),
    fileTreeDepth: Math.min(Math.max(cfg.get<number>('fileTreeDepth', 3), 1), 6),
    maxPriorTasks: Math.max(cfg.get<number>('maxPriorTasks', 3), 1),
  };
}

interface Section {
  priority: number; // lower = higher priority (kept first)
  header: string;
  body: string;
}

/**
 * Build a context string to prepend to the task prompt.
 * Returns empty string if context is disabled or produces no content.
 */
export function buildContext(options: ContextOptions): string {
  const { settings } = options;
  if (!settings.enabled) {
    return '';
  }

  const sections: Section[] = [];

  if (settings.planOverview) {
    const body = gatherPlanOverview(options.plan, options.playlist, options.task);
    if (body) {
      sections.push({ priority: 1, header: '=== PROJECT PLAN ===', body });
    }
  }

  if (settings.cumulativeProgress) {
    const body = gatherCumulativeProgress(options.historyStore, options.plan, options.task);
    if (body) {
      sections.push({ priority: 2, header: '=== PROGRESS SO FAR ===', body });
    }
  }

  if (settings.changedFiles) {
    const body = gatherChangedFiles(options.historyStore, options.playlist, options.task);
    if (body) {
      sections.push({ priority: 3, header: '=== FILES CHANGED BY PRIOR TASKS ===', body });
    }
  }

  if (settings.relevantFiles) {
    const body = gatherRelevantFiles(options.task, options.cwd, settings);
    if (body) {
      sections.push({ priority: 3.5, header: '=== RELEVANT FILES ===', body });
    }
  }

  if (settings.priorTaskOutputs) {
    const body = gatherPriorOutputs(options.historyStore, options.plan, options.playlist, options.task, settings);
    if (body) {
      sections.push({ priority: 4, header: '=== PRIOR TASK RESULTS ===', body });
    }
  }

  if (settings.projectState) {
    const body = gatherProjectState(options.cwd, settings);
    if (body) {
      sections.push({ priority: 5, header: '=== PROJECT STATE ===', body });
    }
  }

  if (sections.length === 0) {
    return '';
  }

  const trimmed = applyBudget(sections, settings.maxContextChars);
  if (trimmed.length === 0) {
    return '';
  }

  const inner = trimmed.map(s => `${s.header}\n${s.body}`).join('\n\n');
  return `[CONTEXT START]\n${inner}\n[CONTEXT END]`;
}

// ─── Section builders ───

function statusMarker(task: Task, currentTask: Task): string {
  if (task.id === currentTask.id) { return '[current]'; }
  switch (task.status) {
    case TaskStatus.Completed: return '[done]';
    case TaskStatus.Failed: return '[failed]';
    case TaskStatus.Blocked: return '[blocked]';
    case TaskStatus.Skipped: return '[skipped]';
    case TaskStatus.Running: return '[running]';
    default: return '[upcoming]';
  }
}

export function gatherPlanOverview(plan: Plan, currentPlaylist: Playlist, currentTask: Task): string {
  const lines: string[] = [];
  lines.push(`Plan: "${plan.name}"`);
  if (plan.description) {
    lines.push(`Description: ${plan.description}`);
  }
  lines.push('');
  lines.push('Tasks:');

  for (const pl of plan.playlists) {
    lines.push(`  Playlist "${pl.name}":`);
    for (let i = 0; i < pl.tasks.length; i++) {
      const t = pl.tasks[i];
      const marker = statusMarker(t, currentTask);
      const arrow = t.id === currentTask.id ? '  <-- YOU ARE HERE' : '';
      lines.push(`    ${marker} ${i + 1}. ${t.name}${arrow}`);
    }
  }

  return lines.join('\n');
}

export function gatherCumulativeProgress(historyStore: HistoryStore, plan: Plan, currentTask: Task): string {
  const lines: string[] = [];
  const allTasks = plan.playlists.flatMap(pl => pl.tasks);

  for (const t of allTasks) {
    if (t.id === currentTask.id) { break; }
    if (t.status === TaskStatus.Completed) {
      const entries = historyStore.getForTask(t.id);
      const latest = entries[0]; // getForTask returns newest first
      const fileCount = latest?.changedFiles?.length ?? 0;
      const fileSuffix = fileCount > 0 ? ` (${fileCount} file${fileCount === 1 ? '' : 's'} changed)` : '';
      lines.push(`- "${t.name}": completed${fileSuffix}`);
    } else if (t.status === TaskStatus.Failed) {
      lines.push(`- "${t.name}": failed`);
    } else if (t.status === TaskStatus.Blocked) {
      lines.push(`- "${t.name}": blocked`);
    } else if (t.status === TaskStatus.Skipped) {
      lines.push(`- "${t.name}": skipped`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

export function gatherChangedFiles(historyStore: HistoryStore, playlist: Playlist, currentTask: Task): string {
  const fileMap = new Map<string, string>(); // file -> task name that changed it

  for (const t of playlist.tasks) {
    if (t.id === currentTask.id) { break; }
    if (t.status !== TaskStatus.Completed) { continue; }

    const entries = historyStore.getForTask(t.id);
    const latest = entries[0];
    if (latest?.changedFiles) {
      for (const f of latest.changedFiles) {
        fileMap.set(f, t.name); // last writer wins attribution
      }
    }
  }

  if (fileMap.size === 0) { return ''; }

  const lines: string[] = [];
  for (const [file, taskName] of fileMap) {
    lines.push(`${file} (by: ${taskName})`);
  }
  return lines.join('\n');
}

export function gatherPriorOutputs(
  historyStore: HistoryStore,
  plan: Plan,
  playlist: Playlist,
  currentTask: Task,
  settings: ContextSettings,
): string {
  // Collect candidate task IDs, ordered most-recent-first (closest to current task)
  const playlistTaskIds = playlist.tasks.map(t => t.id);
  const currentIdx = playlistTaskIds.indexOf(currentTask.id);
  const priorPlaylistIds = currentIdx > 0 ? playlistTaskIds.slice(0, currentIdx).reverse() : [];

  // Explicit dependencies take priority; then same-playlist prior tasks (most recent first)
  const depIds = new Set(currentTask.dependsOn ?? []);
  const ordered: string[] = [
    ...priorPlaylistIds.filter(id => depIds.has(id)),   // deps that are in this playlist first
    ...priorPlaylistIds.filter(id => !depIds.has(id)),  // then remaining playlist tasks
    ...[...depIds].filter(id => !playlistTaskIds.includes(id)), // cross-playlist deps last
  ];

  if (settings.allPriorOutputs) {
    // allPriorOutputs already included via priorPlaylistIds above — just ensure all deps present
  } else if (depIds.size === 0) {
    // No explicit deps and allPriorOutputs=false: include only the N most recent same-playlist tasks
    ordered.splice(0, ordered.length, ...priorPlaylistIds.slice(0, settings.maxPriorTasks));
  }

  // Apply maxPriorTasks cap
  const capped = ordered.slice(0, settings.maxPriorTasks);
  if (capped.length === 0) { return ''; }

  const allTasks = plan.playlists.flatMap(pl => pl.tasks);
  const taskNameMap = new Map(allTasks.map(t => [t.id, t.name]));

  const parts: string[] = [];
  for (const taskId of capped) {
    const entries = historyStore.getForTask(taskId);
    const latest = entries[0]; // newest first
    if (!latest || latest.status !== TaskStatus.Completed) { continue; }

    const name = taskNameMap.get(taskId) ?? taskId;
    let stdout = latest.result.stdout || '';

    if (stdout.length > settings.maxOutputPerTask) {
      stdout = '...[truncated]...\n' + stdout.slice(stdout.length - settings.maxOutputPerTask);
    }

    if (stdout.trim()) {
      parts.push(`--- Task "${name}" (completed) ---\n${stdout.trim()}`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : '';
}

/** Max size for a single file to be included as relevant context */
const MAX_RELEVANT_FILE_BYTES = 5 * 1024;

/** File extensions that signal a path reference in a prompt */
const PATH_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|css|scss|html|json|yaml|yml|toml|md|sh|sql)$/;

/** Match file-path-like tokens in text */
const PATH_PATTERN = /(?:^|\s|['"`(,])([a-zA-Z0-9_\-./\\]+(?:\/[a-zA-Z0-9_\-./\\]+)+(?:\.[a-zA-Z0-9]+)?)/g;

/** Always-include files: extract only relevant portions to save budget */
const ALWAYS_INCLUDE: { file: string; extract: (raw: string) => string | null }[] = [
  {
    file: 'package.json',
    extract: (raw) => {
      try {
        const pkg = JSON.parse(raw);
        const slim: Record<string, unknown> = {};
        for (const key of ['scripts', 'dependencies', 'devDependencies']) {
          if (pkg[key]) { slim[key] = pkg[key]; }
        }
        return Object.keys(slim).length > 0 ? JSON.stringify(slim, null, 2) : null;
      } catch { return null; }
    },
  },
  {
    file: 'tsconfig.json',
    extract: (raw) => {
      try {
        const tsconfig = JSON.parse(raw);
        if (tsconfig.compilerOptions) {
          return JSON.stringify({ compilerOptions: tsconfig.compilerOptions }, null, 2);
        }
        return null;
      } catch { return null; }
    },
  },
];

/**
 * Scan the task prompt for file paths, read existing ones, and include their content.
 * Also always includes package.json (scripts+deps) and tsconfig.json (compilerOptions) if present.
 */
export function gatherRelevantFiles(task: Task, cwd: string, settings: ContextSettings): string {
  const budget = settings.maxFileContextChars;
  const parts: string[] = [];
  let totalChars = 0;
  const included = new Set<string>();

  // Helper: add a file's content (or extracted portion) to the output
  const addFile = (relPath: string, content: string): boolean => {
    if (included.has(relPath)) { return false; }
    if (totalChars + content.length > budget) { return false; }
    included.add(relPath);
    const block = `--- ${relPath} ---\n${content}`;
    parts.push(block);
    totalChars += block.length;
    return true;
  };

  // 1. Always-include files (extracted portions only)
  for (const { file, extract } of ALWAYS_INCLUDE) {
    const fullPath = path.join(cwd, file);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const extracted = extract(raw);
      if (extracted) {
        addFile(file, extracted);
      }
    } catch {
      // file doesn't exist — skip
    }
  }

  // 2. Scan prompt for file path references
  const prompt = task.prompt || '';
  const detectedPaths = new Set<string>();

  let match: RegExpExecArray | null;
  const pattern = new RegExp(PATH_PATTERN.source, 'g');
  while ((match = pattern.exec(prompt)) !== null) {
    detectedPaths.add(match[1]);
  }

  // Also look for simple filenames with known extensions (e.g., "package.json", "tsconfig.json")
  const simpleFilePattern = /(?:^|\s|['"`(,])([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)/g;
  while ((match = simpleFilePattern.exec(prompt)) !== null) {
    if (PATH_EXTENSIONS.test(match[1])) {
      detectedPaths.add(match[1]);
    }
  }

  // 3. Resolve and read each detected path
  for (const detectedPath of detectedPaths) {
    // Normalize separators
    const normalized = detectedPath.replace(/\\/g, '/');
    const resolved = path.join(cwd, normalized);

    // Security: ensure the resolved path is within cwd
    const realCwd = fs.realpathSync(cwd);
    let realResolved: string;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      continue; // file doesn't exist
    }
    if (!realResolved.startsWith(realCwd)) { continue; }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) { continue; }
      if (stat.size > MAX_RELEVANT_FILE_BYTES) { continue; }

      const content = fs.readFileSync(resolved, 'utf-8');
      if (!addFile(normalized, content)) {
        break; // budget exhausted
      }
    } catch {
      // can't read — skip
    }
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', '.next', 'build', 'coverage',
  '.vscode', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  'venv', '.venv', 'env', '.env',
]);

const PROJECT_STATE_CACHE_TTL_MS = 15000;
const projectStateCache = new Map<string, { builtAt: number; value: string }>();

export function gatherProjectState(cwd: string, settings: ContextSettings): string {
  const cacheKey = `${cwd}|depth:${settings.fileTreeDepth}`;
  const cached = projectStateCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.builtAt) < PROJECT_STATE_CACHE_TTL_MS) {
    return cached.value;
  }

  const parts: string[] = [];

  // File tree
  const tree = buildFileTree(cwd, settings.fileTreeDepth);
  if (tree) {
    parts.push(`File tree (depth ${settings.fileTreeDepth}):\n${tree}`);
  }

  // README excerpt
  const readmePath = findReadme(cwd);
  if (readmePath) {
    try {
      const content = fs.readFileSync(readmePath, 'utf-8');
      const excerpt = content.slice(0, 2000);
      const suffix = content.length > 2000 ? '\n...[truncated]' : '';
      parts.push(`README:\n${excerpt}${suffix}`);
    } catch {
      // ignore read errors
    }
  }

  // package.json key fields
  const pkgPath = path.join(cwd, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const extracted: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'scripts', 'dependencies', 'devDependencies']) {
      if (pkg[key] !== undefined) {
        extracted[key] = pkg[key];
      }
    }
    if (Object.keys(extracted).length > 0) {
      parts.push(`package.json (key fields):\n${JSON.stringify(extracted, null, 2)}`);
    }
  } catch {
    // no package.json or invalid JSON
  }

  const value = parts.join('\n\n');
  projectStateCache.set(cacheKey, { builtAt: now, value });
  return value;
}

function findReadme(cwd: string): string | null {
  const candidates = ['README.md', 'readme.md', 'README.txt', 'README'];
  for (const name of candidates) {
    const full = path.join(cwd, name);
    try {
      if (fs.statSync(full).isFile()) {
        return full;
      }
    } catch {
      // not found
    }
  }
  return null;
}

/** Max entries in file tree to prevent huge output on large repos */
const MAX_TREE_ENTRIES = 500;

function buildFileTree(dir: string, maxDepth: number, currentDepth = 0, prefix = '', counter = { count: 0 }): string {
  if (currentDepth >= maxDepth || counter.count >= MAX_TREE_ENTRIES) { return ''; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) { return aDir - bDir; }
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  for (const entry of entries) {
    if (counter.count >= MAX_TREE_ENTRIES) {
      lines.push(`${prefix}... (truncated)`);
      break;
    }
    if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) { continue; }
    if (IGNORED_DIRS.has(entry.name)) { continue; }

    // Skip symlinks to prevent infinite loops and directory escape
    if (entry.isSymbolicLink()) { continue; }

    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      counter.count++;
      const sub = buildFileTree(path.join(dir, entry.name), maxDepth, currentDepth + 1, prefix + '  ', counter);
      if (sub) { lines.push(sub); }
    } else {
      lines.push(`${prefix}${entry.name}`);
      counter.count++;
    }
  }

  return lines.join('\n');
}

/** Drop lowest-priority sections until total fits within budget */
export function applyBudget(sections: Section[], maxChars: number): Section[] {
  // Sort by priority (lower number = higher priority = keep first)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);

  let totalChars = sorted.reduce((sum, s) => sum + s.header.length + 1 + s.body.length + 2, 0);
  // +1 for \n between header and body, +2 for \n\n between sections

  // Drop from the end (lowest priority) until under budget
  while (sorted.length > 0 && totalChars > maxChars) {
    const dropped = sorted.pop()!;
    totalChars -= (dropped.header.length + 1 + dropped.body.length + 2);
  }

  // If still over budget (single section too large), hard-truncate the last section's body
  if (sorted.length > 0 && totalChars > maxChars) {
    const last = sorted[sorted.length - 1];
    const overhead = totalChars - last.body.length;
    const allowedBody = maxChars - overhead;
    if (allowedBody > 0) {
      last.body = last.body.slice(0, allowedBody) + '\n...[truncated]';
    } else {
      sorted.pop();
    }
  }

  return sorted;
}
