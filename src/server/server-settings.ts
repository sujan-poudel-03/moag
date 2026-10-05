// ─── Server-wide admin settings ───
//
// Small persisted switches an admin changes at runtime (`PATCH
// /api/admin/settings`, audited as `settings.update`). Stored as
// `server-settings.json` in the data dir. Every setting defaults to its safe
// value: a missing, unreadable or malformed file reads as the defaults, never
// as a permissive setting.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../utils/file-io';

export interface ServerSettings {
  /**
   * Let plan generation run on an engine whose CLI cannot be denied file and
   * tool access (see `PLANNER_LOCKED_ENGINES` in run-env.ts). Default false:
   * such engines are refused for plan generation.
   */
  allowPlannerFileAccess: boolean;
}

export const DEFAULT_SERVER_SETTINGS: Readonly<ServerSettings> = Object.freeze({ allowPlannerFileAccess: false });

export class ServerSettingsStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'server-settings.json');
  }

  /** Current settings; the defaults for any missing or malformed value. */
  get(): ServerSettings {
    let raw: unknown = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { raw = null; }
    const doc = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      allowPlannerFileAccess: doc.allowPlannerFileAccess === true,
    };
  }

  /** Apply `patch` and persist. Returns the settings before and after. */
  update(patch: Partial<ServerSettings>): { before: ServerSettings; after: ServerSettings } {
    const before = this.get();
    const after: ServerSettings = { ...before };
    if (typeof patch.allowPlannerFileAccess === 'boolean') { after.allowPlannerFileAccess = patch.allowPlannerFileAccess; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomicSync(this.file, JSON.stringify(after, null, 2), 0o600);
    return { before, after };
  }
}
