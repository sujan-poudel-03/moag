// ─── Context Builder — enriches task prompts with plan-aware context ───

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Plan, Playlist, Task, TaskStatus, HistoryEntry } from '../models/types';
import { HistoryStore } from '../history/store';
import { semanticSearch, formatSpans, SemanticSpan } from './semantic-provider';

/** Telemetry record for context budget usage — populated by buildContext */
export interface ContextBudgetUsage {
  /** Chars consumed by all context sections combined */
  totalCharsUsed: number;
  /** Max chars allowed (from settings) */
  totalCharsBudget: number;
  /** How many sections were dropped to stay within budget */
  sectionsDropped: number;
  /** Whether semantic retrieval was used for any section */
  usedSemanticRetrieval: boolean;
  /** Number of high-confidence semantic spans returned */
  semanticSpansReturned: number;
}

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
  /** If provided, budget usage telemetry is written here after buildContext returns */
  budgetUsage?: ContextBudgetUsage;
  /**
   * Paths to screenshots captured via the sandbox panel.
   * When provided, they are appended as a high-priority context section so
   * the agent can see what the running app looks like before acting.
   * The caller is responsible for clearing this queue after passing it in.
   */
  pendingScreenshots?: string[];
  /**
   * Pre-fetched ranked code spans from runRetrievalCascade.
   * When provided, emitted as a high-priority section instead of whole-file retrieval.
   */
  retrievedSpans?: SemanticSpan[];
  /** True when retrievedSpans were produced by the semantic provider (not just rg/hint). */
  retrievedSpansUsedSemantic?: boolean;
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
 *
 * Retrieval cascade (highest priority first):
 * 1. Plan overview + progress (always cheap, text-only)
 * 2. rg/glob-based changed-files + relevant-files discovery
 * 3. Semantic span retrieval (when provider is registered and confident)
 * 4. Project state / README (optional, lowest priority)
 *
 * Budget telemetry is written to options.budgetUsage when provided.
 *
 * Returns empty string if context is disabled or produces no content.
 */
export function buildContext(options: ContextOptions): string {
  const { settings } = options;
  if (!settings.enabled) {
    return '';
  }

  const sections: Section[] = [];
  let usedSemanticRetrieval = options.retrievedSpansUsedSemantic ?? false;
  let semanticSpansReturned = options.retrievedSpans?.length ?? 0;

  if (options.pendingScreenshots && options.pendingScreenshots.length > 0) {
    const body = options.pendingScreenshots
      .map((p, i) => `Screenshot ${i + 1}: ${p}`)
      .join('\n');
    sections.push({ priority: 0, header: '=== SANDBOX SCREENSHOTS ===', body });
  }

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

  // Ranked spans from retrieval cascade — preferred over whole-file content
  if (options.retrievedSpans && options.retrievedSpans.length > 0) {
    const spanBudget = Math.floor(settings.maxFileContextChars * 0.8);
    const body = formatSpans(options.retrievedSpans, spanBudget);
    if (body) {
      sections.push({ priority: 3.3, header: '=== RELEVANT CODE SPANS ===', body });
    }
  } else if (settings.relevantFiles) {
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
    // Write zero telemetry and return early
    if (options.budgetUsage) {
      Object.assign(options.budgetUsage, {
        totalCharsUsed: 0,
        totalCharsBudget: settings.maxContextChars,
        sectionsDropped: 0,
        usedSemanticRetrieval: false,
        semanticSpansReturned: 0,
      } satisfies ContextBudgetUsage);
    }
    return '';
  }

  const beforeTrim = sections.length;
  const trimmed = applyBudget(sections, settings.maxContextChars);
  const sectionsDropped = beforeTrim - trimmed.length;

  if (trimmed.length === 0) {
    if (options.budgetUsage) {
      Object.assign(options.budgetUsage, {
        totalCharsUsed: 0,
        totalCharsBudget: settings.maxContextChars,
        sectionsDropped,
        usedSemanticRetrieval,
        semanticSpansReturned,
      } satisfies ContextBudgetUsage);
    }
    return '';
  }

  // Write budget telemetry
  const totalCharsUsed = trimmed.reduce(
    (sum, s) => sum + s.header.length + 1 + s.body.length + 2,
    0,
  );

  if (options.budgetUsage) {
    Object.assign(options.budgetUsage, {
      totalCharsUsed,
      totalCharsBudget: settings.maxContextChars,
      sectionsDropped,
      usedSemanticRetrieval,
      semanticSpansReturned,
    } satisfies ContextBudgetUsage);
  }

  const inner = trimmed.map(s => `${s.header}\n${s.body}`).join('\n\n');
  return `[CONTEXT START]\n${inner}\n[CONTEXT END]`;
}

/**
 * Run the full retrieval cascade for a task prompt and return ranked spans.
 *
 * Stages (highest priority first):
 * 1. Symbol/project hints — camelCase/PascalCase identifiers extracted from prompt,
 *    scanned in-process across up to 30 source files (confidence 0.6)
 * 2. rg/glob keyword search — broader token extraction (ALL_CAPS, snake_case, plain
 *    identifiers) scanned across up to 50 files; replaces overlapping hint spans
 *    in the same files (confidence 0.65)
 * 3. Semantic provider — when a provider is registered and returns confident results,
 *    its spans replace deterministic spans for covered files (highest quality)
 *
 * Returns `{ spans, usedSemantic }`. Callers pass `spans` to `buildContext` via
 * `ContextOptions.retrievedSpans`; when spans is empty, `buildContext` falls back
 * to whole-file `gatherRelevantFiles`.
 */
export async function runRetrievalCascade(
  task: Task,
  cwd: string,
  budget: number,
): Promise<{ spans: SemanticSpan[]; usedSemantic: boolean }> {
  // Stage 1 — symbol/project hint spans (camelCase/PascalCase, confidence 0.6)
  const hintSpans = gatherSymbolHintSpans(task.prompt, cwd, budget);

  // Stage 2 — rg/glob keyword spans (broader coverage, confidence 0.65)
  // Overlapping hint spans in the same files are replaced by the higher-confidence rg spans
  const rgSpans = gatherRgGlobSpans(task.prompt, cwd, budget);
  const deterministicSpans = mergeSpans(hintSpans, rgSpans);

  // Stage 3 — semantic provider (async, optional, highest quality)
  const semanticSpans = await semanticSearch({
    query: task.prompt,
    cwd,
    maxSpans: 20,
    fileGlob: '*.ts',
  });

  if (semanticSpans.length > 0) {
    // Semantic spans take priority; keep deterministic extras for uncovered files
    const coveredFiles = new Set(semanticSpans.map(s => s.filePath));
    const extras = deterministicSpans.filter(s => !coveredFiles.has(s.filePath));
    return { spans: [...semanticSpans, ...extras], usedSemantic: true };
  }

  // No semantic results — return deterministic (rg + hint) spans
  return { spans: deterministicSpans, usedSemantic: false };
}

export { formatSpans };

// ─── Symbol hint retrieval ───

/** Matches camelCase and PascalCase identifiers (4+ chars) */
const SYMBOL_HINT_PATTERN = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]{2,})\b/g;

/** Matches any identifier-like token of 4+ chars (captures ALL_CAPS, snake_case, plain words) */
const KEYWORD_PATTERN = /\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g;

/** Lines of surrounding context to include around a symbol match */
const SPAN_CONTEXT_LINES = 3;

/** Max source files to scan during hint extraction */
const MAX_HINT_SCAN_FILES = 30;

/** Max source files to scan during rg/glob keyword extraction */
const MAX_RG_SCAN_FILES = 50;

/** Max file size to scan for symbol hints (50 KB) */
const MAX_HINT_FILE_BYTES = 50 * 1024;

/** Common English words that are never useful code search terms */
const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'will', 'your', 'what', 'when', 'then',
  'they', 'them', 'into', 'just', 'also', 'some', 'each', 'like', 'over', 'where',
  'been', 'were', 'there', 'their', 'would', 'could', 'should', 'which', 'about',
  'after', 'before', 'because', 'through', 'make', 'more', 'only', 'both', 'used',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract symbol identifiers from a prompt, find their occurrences in source
 * files (with surrounding context), and return as SemanticSpan[].
 *
 * Files are scanned in priority order: prompt-referenced files first, then
 * src/ directory files up to MAX_HINT_SCAN_FILES.
 */
export function gatherSymbolHintSpans(prompt: string, cwd: string, budget: number): SemanticSpan[] {
  const symbols = new Set<string>();
  const symPattern = new RegExp(SYMBOL_HINT_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = symPattern.exec(prompt)) !== null) {
    symbols.add(m[1]);
  }
  if (symbols.size === 0) { return []; }

  const candidateFiles = collectCandidateFiles(cwd, prompt);
  const spans: SemanticSpan[] = [];
  let totalChars = 0;

  for (const relPath of candidateFiles) {
    if (totalChars >= budget) { break; }
    const fullPath = path.join(cwd, relPath);

    let content: string;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > MAX_HINT_FILE_BYTES) { continue; }
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    const matchedLineSet = new Set<number>();

    for (const sym of symbols) {
      const re = new RegExp(`\\b${escapeRegex(sym)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const lo = Math.max(0, i - SPAN_CONTEXT_LINES);
          const hi = Math.min(lines.length - 1, i + SPAN_CONTEXT_LINES);
          for (let j = lo; j <= hi; j++) { matchedLineSet.add(j); }
        }
      }
    }
    if (matchedLineSet.size === 0) { continue; }

    // Group consecutive matched line indices into contiguous ranges
    const sorted = [...matchedLineSet].sort((a, b) => a - b);
    const groups: [number, number][] = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= rangeEnd + 1) {
        rangeEnd = sorted[i];
      } else {
        groups.push([rangeStart, rangeEnd]);
        rangeStart = rangeEnd = sorted[i];
      }
    }
    groups.push([rangeStart, rangeEnd]);

    for (const [lo, hi] of groups) {
      const spanContent = lines.slice(lo, hi + 1).join('\n');
      if (totalChars + spanContent.length > budget) { break; }
      spans.push({
        filePath: relPath,
        startLine: lo + 1,  // 1-indexed
        endLine: hi + 1,
        content: spanContent,
        confidence: 0.6,    // deterministic, moderate confidence
      });
      totalChars += spanContent.length;
    }
  }

  return spans;
}

/**
 * Return source files to scan: prompt-referenced files first, then `src/` files.
 * Normalizes separators and ensures all paths are relative to cwd.
 */
function collectCandidateFiles(cwd: string, prompt: string, maxFiles = MAX_HINT_SCAN_FILES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  // 1. Files explicitly mentioned in the prompt
  const promptPattern = new RegExp(PATH_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = promptPattern.exec(prompt)) !== null) {
    const normalized = m[1].replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      const full = path.join(cwd, normalized);
      try { if (fs.statSync(full).isFile()) { out.push(normalized); } } catch { /* not a file */ }
    }
  }

  // 2. Source files from src/ up to the remaining limit
  const counter = { remaining: maxFiles - out.length };
  const srcDir = path.join(cwd, 'src');
  collectSourceFilesRecursive(srcDir, cwd, seen, out, counter);

  return out;
}

function collectSourceFilesRecursive(
  dir: string,
  cwd: string,
  seen: Set<string>,
  out: string[],
  counter: { remaining: number },
): void {
  if (counter.remaining <= 0) { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (counter.remaining <= 0) { break; }
    if (IGNORED_DIRS.has(entry.name) || entry.isSymbolicLink()) { continue; }
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      collectSourceFilesRecursive(fullPath, cwd, seen, out, counter);
    } else if (entry.isFile() && PATH_EXTENSIONS.test(entry.name) && !seen.has(relPath)) {
      seen.add(relPath);
      out.push(relPath);
      counter.remaining--;
    }
  }
}

/**
 * Extract broad keywords from a prompt and scan source files for matching spans.
 *
 * This is the rg/glob stage — covers identifiers the camelCase/PascalCase symbol
 * hint stage misses: ALL_CAPS constants, snake_case names, and short identifiers.
 * Returns spans with confidence 0.65 (higher than hint spans at 0.6).
 */
export function gatherRgGlobSpans(prompt: string, cwd: string, budget: number): SemanticSpan[] {
  const keywords = new Set<string>();
  const kwPattern = new RegExp(KEYWORD_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = kwPattern.exec(prompt)) !== null) {
    const word = m[1];
    if (!STOP_WORDS.has(word.toLowerCase())) {
      keywords.add(word);
    }
  }
  if (keywords.size === 0) { return []; }

  const candidateFiles = collectCandidateFiles(cwd, prompt, MAX_RG_SCAN_FILES);
  const spans: SemanticSpan[] = [];
  let totalChars = 0;

  for (const relPath of candidateFiles) {
    if (totalChars >= budget) { break; }
    const fullPath = path.join(cwd, relPath);

    let content: string;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > MAX_HINT_FILE_BYTES) { continue; }
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    const matchedLineSet = new Set<number>();

    for (const kw of keywords) {
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const lo = Math.max(0, i - SPAN_CONTEXT_LINES);
          const hi = Math.min(lines.length - 1, i + SPAN_CONTEXT_LINES);
          for (let j = lo; j <= hi; j++) { matchedLineSet.add(j); }
        }
      }
    }
    if (matchedLineSet.size === 0) { continue; }

    const sorted = [...matchedLineSet].sort((a, b) => a - b);
    const groups: [number, number][] = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= rangeEnd + 1) {
        rangeEnd = sorted[i];
      } else {
        groups.push([rangeStart, rangeEnd]);
        rangeStart = rangeEnd = sorted[i];
      }
    }
    groups.push([rangeStart, rangeEnd]);

    for (const [lo, hi] of groups) {
      const spanContent = lines.slice(lo, hi + 1).join('\n');
      if (totalChars + spanContent.length > budget) { break; }
      spans.push({
        filePath: relPath,
        startLine: lo + 1,
        endLine: hi + 1,
        content: spanContent,
        confidence: 0.65,
      });
      totalChars += spanContent.length;
    }
  }

  return spans;
}

/**
 * Merge two span arrays. `higher` spans (higher confidence) replace overlapping
 * `lower` spans in the same file. Non-overlapping lower spans are kept as extras.
 */
export function mergeSpans(lower: SemanticSpan[], higher: SemanticSpan[]): SemanticSpan[] {
  if (higher.length === 0) { return lower; }
  if (lower.length === 0) { return higher; }

  const higherByFile = new Map<string, SemanticSpan[]>();
  for (const s of higher) {
    const arr = higherByFile.get(s.filePath) ?? [];
    arr.push(s);
    higherByFile.set(s.filePath, arr);
  }

  const extras: SemanticSpan[] = [];
  for (const ls of lower) {
    const higherInFile = higherByFile.get(ls.filePath);
    if (!higherInFile) {
      extras.push(ls);
      continue;
    }
    const overlaps = higherInFile.some(
      hs => ls.startLine <= hs.endLine && ls.endLine >= hs.startLine,
    );
    if (!overlaps) {
      extras.push(ls);
    }
  }

  return [...higher, ...extras];
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
