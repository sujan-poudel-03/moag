// ─── How many stages run at once ───
//
// The setting was `agentTaskPlayer.parallelPlaylists` before Playlist became
// Stage; VS Code derives a setting's displayed name from its key, so it is now
// `agentTaskPlayer.parallelStages`. The old key keeps working: a value the
// user set under it is used whenever the new key is not set. No vscode import,
// so the headless CLI reads it the same way.

export const PARALLEL_STAGES_KEY = 'parallelStages';
export const LEGACY_PARALLEL_STAGES_KEY = 'parallelPlaylists';

interface Inspected { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }

/** The part of a `agentTaskPlayer` configuration section this reads. */
export interface ParallelStagesConfig {
  get<T>(key: string, defaultValue?: T): T | undefined;
  inspect?(key: string): Inspected | undefined;
}

/** A value the user set (any scope), or undefined. Without inspect (headless), get has no contributed default. */
function userValue(cfg: ParallelStagesConfig, key: string): number | undefined {
  const inspected = cfg.inspect?.(key);
  const v = inspected
    ? (inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue)
    : cfg.get<unknown>(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The configured stage concurrency: the new key, else the old one, else 1. */
export function readParallelStages(cfg: ParallelStagesConfig): number {
  return userValue(cfg, PARALLEL_STAGES_KEY) ?? userValue(cfg, LEGACY_PARALLEL_STAGES_KEY) ?? 1;
}
