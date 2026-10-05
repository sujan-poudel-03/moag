// ─── PRD → plan generation core ───
//
// Prompt building and response parsing for turning a PRD into a plan. No `vscode`
// import: the engine call is injected, so the same core serves the extension (which
// owns progress, dialogs and file writes in ui/prd-authoring.ts) and, later, the
// headless CLI. Mirrors prd-loop.ts, which does the same for fix tasks.

import { EngineResult, Plan, PlanFile, Playlist, Task, TaskStatus } from '../models/types';
import { hydratePlan } from '../models/plan';
import { isRoleId } from '../models/roles';
import {
  Requirement, collectReservedRequirementIds, computeLatestDiff, formatVersionLabel, resolveRequirements,
} from '../models/requirements';

// ─── Full plan ───

/** The prompt that asks an engine for a complete Design → Development → Testing plan. */
export function buildFullPlanPrompt(prdText: string): string {
  return `You are a senior engineering lead. Given the Product Requirements Document (PRD) below, generate a structured JSON execution plan for an AI coding agent.

The plan MUST have up to three playlists in this order:
1. "Design" — UI/UX specs, component sketches, API contract decisions. OMIT this playlist if the PRD mentions no user interface or front-end work.
2. "Development" — implementation tasks (backend, frontend, infrastructure, migrations, etc.)
3. "Testing" — test writing, QA, edge-case coverage, accessibility checks (set "testPhase": true)

Rules:
- Each task must have: "id" (unique string e.g. "task-1"), "name" (short title), "prompt" (detailed enough for Claude Code to execute autonomously — include file paths, acceptance criteria, patterns to follow), "status": "pending"
- Task type rules — include optional "type" field (defaults to "agent"):
  - "agent"       AI coding tasks (most tasks)
  - "command"     Shell commands (test deps.runners, builds). Set "command" field to the exact shell command (e.g., "npm test", "pytest", "go test ./..."). The Testing playlist MUST include at least one "command" task running the test suite.
  - "visual-test" Browser UI verification via screenshot + vision. For web/frontend projects only.
- Each playlist must have: "id" (unique string), "name" (string), "testPhase" (boolean — true only for Testing), "tasks" (array)
- Each playlist SHOULD have a "role" — the expert persona the agent adopts. Exactly one of:
  "architect" | "designer" | "engineer" | "reviewer" | "tester" | "devops".
  Typical mapping: Design → "designer", Development → "engineer", Testing → "tester".
  Omit the field entirely if unsure. Never invent a value outside that list.
- The root plan object must have: "version": "1.0", "name" (brief feature name derived from the PRD), "description" (one sentence), "playlists" (array)
- Return ONLY valid JSON. No markdown code fences, no explanation, no preamble.
- Keep tasks focused and atomic — one concern per task.

PRD:
${prdText}`;
}

// ─── Parsing ───

/** The only requirement-ID shape a generated task may carry. */
const REQUIREMENT_ID_RE = /^R-\d+$/;

/**
 * Coerce each model-emitted task's `requirementIds` in place before hydration, which would
 * otherwise reject the whole plan for one bad task: a non-array is dropped, and an array
 * keeps only its `R-<n>` string entries (dropped entirely when none remain), so a junk ID
 * can never reach the plan and surface as a 'removed' row in `moag trace`. A task left
 * without IDs is then rejected on its own by buildDeltaPlaylist, not the whole response.
 */
function coerceRequirementIds(playlists: unknown[]): void {
  for (const pl of playlists) {
    const tasks = pl && typeof pl === 'object' ? (pl as { tasks?: unknown }).tasks : undefined;
    if (!Array.isArray(tasks)) { continue; }
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || !('requirementIds' in task)) { continue; }
      const t = task as { requirementIds?: unknown };
      const ids = Array.isArray(t.requirementIds)
        ? t.requirementIds.filter((id): id is string => typeof id === 'string' && REQUIREMENT_ID_RE.test(id))
        : [];
      if (ids.length > 0) { t.requirementIds = ids; } else { delete t.requirementIds; }
    }
  }
}

/** Result of parsing an engine's plan JSON — a hydrated plan, or a user-facing error. */
export type GeneratedPlanParse =
  | { ok: true; plan: Plan; invalidRoleCount: number }
  | { ok: false; error: string };

/**
 * Parse an engine's plan response: strip stray code fences, parse JSON, check the
 * required fields and hydrate. A hydrate failure is returned as an error — never
 * swallowed — so a malformed plan is reported instead of written.
 */
export function parseGeneratedPlan(stdout: string, sourceName = 'generated plan'): GeneratedPlanParse {
  // Strip markdown fences if the AI ignored the instruction
  const planJson = stdout.trim().replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    return { ok: false, error: 'AI returned invalid JSON. Try again.' };
  }

  const candidate = (parsed && typeof parsed === 'object' ? parsed : {}) as
    { version?: unknown; name?: unknown; playlists?: unknown };
  if (!candidate.version || !candidate.name || !Array.isArray(candidate.playlists) || candidate.playlists.length === 0) {
    return { ok: false, error: 'Generated plan is missing required fields (version, name, playlists).' };
  }

  // Count roles the generator invented before hydration silently coerces them away, so the
  // completion notification can say why a playlist came back without the role it asked for.
  const invalidRoleCount = (candidate.playlists as Array<{ role?: unknown } | null>)
    .filter(pl => pl?.role !== undefined && !isRoleId(pl.role)).length;

  coerceRequirementIds(candidate.playlists as unknown[]);

  try {
    const plan = hydratePlan(candidate as PlanFile, sourceName);
    return { ok: true, plan, invalidRoleCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Generated plan could not be loaded: ${msg}` };
  }
}

// ─── Delta plan ───

/** What changed in the latest PRD version — the only requirements a delta plan may cover. */
export interface DeltaScope {
  versionLabel: string;
  added: Requirement[];
  changed: Array<{ id: string; before: string; after: string }>;
}

/** How a delta-plan generation ended. Only `appended` changed the plan. */
export type DeltaPlanOutcome =
  | { kind: 'no-delta' }
  | { kind: 'engine-failed'; error: string }
  | { kind: 'parse-failed'; error: string }
  | { kind: 'all-rejected'; rejected: DeltaRejection[] }
  | { kind: 'appended'; playlist: Playlist; rejected: DeltaRejection[] };

/** A generated task that was not added, and why. */
export interface DeltaRejection {
  taskName: string;
  reason: string;
}

/** Longest `prdContext` a delta playlist carries. */
const MAX_DELTA_CONTEXT_CHARS = 4000;

/**
 * The added and changed requirements of the latest PRD version against the one before it.
 * Removed requirements are never part of the scope. Null when there is no previous
 * version or nothing was added or changed.
 */
export function describeDeltaScope(plan: Plan): DeltaScope | null {
  const versions = plan.prdVersions ?? [];
  if (versions.length < 2) { return null; }
  const reserved = [...collectReservedRequirementIds(plan)];
  const diff = computeLatestDiff(versions, reserved);
  if (!diff || diff.added.length + diff.changed.length === 0) { return null; }
  const last = versions[versions.length - 1];
  // Resolved exactly as computeLatestDiff resolves the newer side, so the IDs agree.
  const latest = resolveRequirements(last.text, undefined, reserved);
  const addedIds = new Set(diff.added.map(a => a.id));
  return {
    versionLabel: last.version,
    added: latest.filter(r => addedIds.has(r.id)),
    changed: diff.changed.map(c => ({ id: c.id, before: c.before, after: c.after })),
  };
}

/** Every ID in a delta scope, added first, in the scope's order. */
function scopeIds(scope: DeltaScope): string[] {
  return [...scope.added.map(r => r.id), ...scope.changed.map(c => c.id)];
}

/** One line per delta requirement: `- [R-4] (added) …` / `- [R-2] (changed) before: … → after: …`. */
function deltaLines(scope: DeltaScope): string[] {
  return [
    ...scope.added.map(r => `- [${r.id}] (added) ${r.text}`),
    ...scope.changed.map(c => `- [${c.id}] (changed) before: ${c.before} → after: ${c.after}`),
  ];
}

/**
 * The prompt for a delta plan: tasks for the added and changed requirements only, each
 * citing the IDs it covers, with the full PRD appended as context.
 */
export function buildDeltaPlanPrompt(input: { fullPrdText: string; scope: DeltaScope }): string {
  const ids = scopeIds(input.scope);
  return `You are a senior engineering lead. A Product Requirements Document (PRD) was revised to ${formatVersionLabel(input.scope.versionLabel)}. Generate a structured JSON execution plan that covers ONLY the requirements listed under "Changed requirements" — nothing else in the PRD.

Changed requirements:
${deltaLines(input.scope).join('\n')}

Rules:
- Return a plan JSON object with a single playlist of tasks.
- Every task MUST have a "requirementIds" array citing ONLY IDs from this list: ${ids.join(', ')}. A task that cites none of them is discarded.
- Include at least one "command" task that runs the test suite, with "requirementIds": [${ids.map(id => `"${id}"`).join(', ')}].
- Each task must have: "id" (unique string e.g. "task-1"), "name" (short title), "prompt" (detailed enough for Claude Code to execute autonomously — include file paths, acceptance criteria, patterns to follow), "status": "pending", "requirementIds" (array)
- Task type rules — include optional "type" field (defaults to "agent"):
  - "agent"       AI coding tasks (most tasks)
  - "command"     Shell commands (test runners, builds). Set "command" field to the exact shell command (e.g., "npm test", "pytest", "go test ./...").
  - "visual-test" Browser UI verification via screenshot + vision. For web/frontend projects only.
- Optional "dependsOn": an array of task ids from this same plan.
- The playlist must have: "id" (unique string), "name" (string), "testPhase" (boolean), "tasks" (array)
- The playlist SHOULD have a "role" — the expert persona the agent adopts. Exactly one of:
  "architect" | "designer" | "engineer" | "reviewer" | "tester" | "devops".
  Omit the field entirely if unsure. Never invent a value outside that list.
- The root plan object must have: "version": "1.0", "name" (brief name for this change), "description" (one sentence), "playlists" (array)
- Return ONLY valid JSON. No markdown code fences, no explanation, no preamble.
- Keep tasks focused and atomic — one concern per task.

Full PRD (context only — do not plan work for requirements not listed above):
${input.fullPrdText}`;
}

/**
 * Turn a generated plan into one append-only delta playlist. Each task keeps only the
 * delta IDs it cites; a task citing none is rejected and reported, never stored untagged.
 * Task IDs are reassigned so they cannot collide with the plan, and `dependsOn` is
 * remapped (unknown references are dropped).
 */
export function buildDeltaPlaylist(generated: Plan, opts: {
  deltaIds: string[];
  versionLabel: string;
  existingIds: ReadonlySet<string>;
  prdContext: string;
  idPrefix: string;
}): { playlist: Playlist | null; rejected: DeltaRejection[] } {
  const allowed = new Set(opts.deltaIds);
  const byNumber = (a: string, b: string) => Number(a.slice(2)) - Number(b.slice(2));
  const rejected: DeltaRejection[] = [];
  const kept: Array<{ task: Task; oldId: string; ids: string[] }> = [];

  for (const pl of generated.playlists) {
    for (const task of pl.tasks) {
      const ids = [...new Set((task.requirementIds ?? []).filter(id => allowed.has(id)))].sort(byNumber);
      if (ids.length === 0) {
        rejected.push({ taskName: task.name, reason: `cites none of ${opts.deltaIds.join(', ')}` });
        continue;
      }
      kept.push({ task, oldId: task.id, ids });
    }
  }
  if (kept.length === 0) { return { playlist: null, rejected }; }

  const idMap = new Map<string, string>();
  const taken = new Set(opts.existingIds);
  let counter = 1;
  for (const k of kept) {
    let id = `${opts.idPrefix}-${counter++}`;
    while (taken.has(id)) { id = `${opts.idPrefix}-${counter++}`; }
    taken.add(id);
    // First occurrence wins if the generator repeated an id.
    if (!idMap.has(k.oldId)) { idMap.set(k.oldId, id); }
    k.task = { ...k.task, id };
  }

  const tasks: Task[] = kept.map(k => {
    const dependsOn = (k.task.dependsOn ?? [])
      .map(dep => idMap.get(dep))
      .filter((dep): dep is string => dep !== undefined && dep !== k.task.id);
    const task: Task = { ...k.task, status: TaskStatus.Pending, requirementIds: k.ids };
    if (dependsOn.length > 0) { task.dependsOn = [...new Set(dependsOn)]; } else { delete task.dependsOn; }
    return task;
  });

  return {
    playlist: {
      id: `pl-delta-${opts.idPrefix}`,
      name: `PRD ${formatVersionLabel(opts.versionLabel)} delta`,
      role: 'engineer',
      autoplay: true,
      testPhase: false,
      prdContext: opts.prdContext.slice(0, MAX_DELTA_CONTEXT_CHARS),
      tasks,
    },
    rejected,
  };
}

/**
 * Generate a delta plan for the latest PRD version and append it to `plan` as one new
 * playlist. Never replaces the plan and never touches `prdVersions`, `prdSource` or
 * `requirementTrace`. The engine call is injected; one call per invocation.
 */
export async function generateDeltaPlan(plan: Plan, deps: {
  runEngine: (prompt: string, signal: AbortSignal) => Promise<EngineResult>;
  signal: AbortSignal;
  now?: () => number;
}): Promise<DeltaPlanOutcome> {
  const scope = describeDeltaScope(plan);
  const versions = plan.prdVersions ?? [];
  if (!scope || versions.length === 0) { return { kind: 'no-delta' }; }

  const prompt = buildDeltaPlanPrompt({ fullPrdText: versions[versions.length - 1].text, scope });
  let result: EngineResult;
  try {
    result = await deps.runEngine(prompt, deps.signal);
  } catch (err) {
    return { kind: 'engine-failed', error: `Delta plan generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const detail = result.exitCode !== 0 ? `engine exited with code ${result.exitCode}` : 'engine returned no output';
    return { kind: 'engine-failed', error: `AI did not return a delta plan (${detail}).` };
  }

  const parsed = parseGeneratedPlan(result.stdout, 'generated delta plan');
  if (!parsed.ok) { return { kind: 'parse-failed', error: parsed.error }; }

  const existingIds = new Set<string>();
  for (const pl of plan.playlists) {
    for (const t of pl.tasks) { existingIds.add(t.id); }
  }
  const { playlist, rejected } = buildDeltaPlaylist(parsed.plan, {
    deltaIds: scopeIds(scope),
    versionLabel: scope.versionLabel,
    existingIds,
    prdContext: deltaLines(scope).join('\n'),
    idPrefix: `delta-${(deps.now ?? Date.now)().toString(36)}`,
  });
  if (!playlist) { return { kind: 'all-rejected', rejected }; }

  plan.playlists.push(playlist);
  return { kind: 'appended', playlist, rejected };
}
