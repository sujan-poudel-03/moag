// ─── Leftover workers from an earlier bench in the same --out ───
//
// A bench that was killed outright (a memory reaper, a closed terminal) cannot
// stop its jobs. Their worker — and on POSIX, or before the Windows job-object
// binding, the agent it supervised — may still be running and spending, and the
// project's job.lock under `<out>/server-data/projects/<id>/` names them. A re-run
// into the same --out is refused anyway (a non-empty --out is never reused); this
// lets the refusal say which processes are still alive and how to end them.
//
// Nothing here kills anything: a recorded pid may since have been reused by an
// unrelated process.

import * as fs from 'fs';
import * as path from 'path';

export interface LiveLeftover {
  projectId: string;
  serverPid: number | null;
  workerPid: number | null;
  taskPids: number[];
}

/** `process.kill(pid, 0)`: alive, or alive but not ours (EPERM). */
export function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The projects under `outDir` whose job.lock still names a live process, with
 * only the live pids kept (and never this process). Never throws; `[]` when
 * there is no server data.
 */
export function findLiveLeftovers(outDir: string, isAlive: (pid: number) => boolean = defaultIsAlive): LiveLeftover[] {
  const projectsDir = path.join(outDir, 'server-data', 'projects');
  let ids: string[];
  try { ids = fs.readdirSync(projectsDir); } catch { return []; }
  // Lazy: the job manager is only needed when there is something to read.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readJobLock } = require('../server/jobs') as typeof import('../server/jobs');
  const live = (pid: number | null): number | null => {
    if (pid === null || pid === process.pid) { return null; }
    try { return isAlive(pid) ? pid : null; } catch { return null; }
  };
  const out: LiveLeftover[] = [];
  for (const projectId of ids) {
    let info;
    try { info = readJobLock(path.join(projectsDir, projectId, 'job.lock')); } catch { continue; }
    if (!info) { continue; }
    const serverPid = live(info.serverPid);
    const workerPid = live(info.workerPid);
    const taskPids = info.taskPids.map(live).filter((p): p is number => p !== null);
    if (serverPid !== null || workerPid !== null || taskPids.length > 0) {
      out.push({ projectId, serverPid, workerPid, taskPids });
    }
  }
  return out;
}

/** The refusal text for live leftovers: each project's pids and the platform's kill commands. */
export function describeLeftovers(outDir: string, leftovers: readonly LiveLeftover[], platform: NodeJS.Platform = process.platform): string {
  const lines = [`--out ${outDir} is not empty, and a previous bench there left processes running that may still be spending:`];
  const pids: number[] = [];
  for (const l of leftovers) {
    const parts = [
      ...(l.serverPid !== null ? [`server ${l.serverPid}`] : []),
      ...(l.workerPid !== null ? [`worker ${l.workerPid}`] : []),
      ...(l.taskPids.length > 0 ? [`task ${l.taskPids.join(', ')}`] : []),
    ];
    lines.push(`  project ${l.projectId}: ${parts.join('; ')}`);
    for (const p of [l.workerPid, ...l.taskPids, l.serverPid]) { if (p !== null && !pids.includes(p)) { pids.push(p); } }
  }
  lines.push('Check each one is yours, then end it:');
  for (const p of pids) {
    lines.push(platform === 'win32' ? `  taskkill /T /F /PID ${p}` : `  kill -TERM -${p}; kill -TERM ${p}`);
  }
  lines.push('Nothing was started. Use a fresh --out once they are gone.');
  return lines.join('\n');
}
