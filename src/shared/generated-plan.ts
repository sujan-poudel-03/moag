// ─── Generated-plan hygiene (pure, shared) ───
//
// Checks applied to a model-generated playlist before anyone may approve it.
// The hosted server (`server/prd-ops.ts`, which re-exports these) and the
// ONOSOO remote child both apply them; the remote child ships in the extension
// and the server does not, so they live here.

import * as path from 'path';
import { PlanFilePlaylist, PlanFileTask } from '../models/types';

/** Task fields a generated plan may never carry: removed before hashing and review. */
export const STRIPPED_GENERATED_FIELDS = ['env', 'inheritEnvFiles', 'githubRelease', 'releaseTag'] as const;
export type StrippedGeneratedField = typeof STRIPPED_GENERATED_FIELDS[number];

/** One side-effect field removed from one generated task. */
export interface StrippedGeneratedEntry { taskId: string; taskName: string; field: StrippedGeneratedField }

/**
 * Remove {@link STRIPPED_GENERATED_FIELDS} from every task of a generated
 * playlist: env injection, env-file inheritance and git tag/push are never
 * model-chosen. Mutates `pl`; returns what was removed.
 */
export function stripGeneratedSideEffects(pl: PlanFilePlaylist): StrippedGeneratedEntry[] {
  const stripped: StrippedGeneratedEntry[] = [];
  for (const t of (pl.tasks ?? []) as PlanFileTask[]) {
    for (const field of STRIPPED_GENERATED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(t, field)) {
        delete t[field];
        stripped.push({ taskId: t.id, taskName: t.name, field });
      }
    }
  }
  return stripped;
}

/**
 * Does a task `cwd` leave the project workspace? The runner joins a relative
 * cwd onto the workspace root and uses an absolute one as-is, so an absolute
 * path (POSIX, Windows drive, drive-relative `C:x` or UNC) escapes, and so does
 * a relative path whose `..` segments climb above the root at any point.
 * Either separator counts: the plan may run on Windows or POSIX.
 */
export function cwdEscapesWorkspace(cwd: string): boolean {
  if (path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd)) { return true; }
  let depth = 0;
  for (const seg of cwd.split(/[\\/]+/)) {
    if (seg === '..') { depth--; if (depth < 0) { return true; } }
    else if (seg !== '' && seg !== '.') { depth++; }
  }
  return false;
}
