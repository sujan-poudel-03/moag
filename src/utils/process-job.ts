// ─── Windows job object: tie a process tree to one process's lifetime ───
//
// Every kill path MOAG has on Windows is `taskkill /T` (runCli abort, runner.stop,
// JobManager's hard kill, the run worker's disconnect watchdog). `/T` finds
// descendants by PARENT PID only, so a descendant whose parent already exited —
// a shell the agent CLI started for a tool call, `cmd /c start /b …`, a background
// command — cannot be reached from any ancestor. It survives every stop and keeps
// writing to the workspace and spending.
//
// A job object does not care about parentage: every process created by a member
// inherits membership. With JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, Windows terminates
// every process still in the job when its LAST handle closes.
//
// The job is made by a short-lived PowerShell helper that creates it, DUPLICATES
// the job handle into the target process and assigns the target, then exits. From
// then on the only handle lives in the target's own handle table, so the job lasts
// exactly as long as the target — whether it exits normally, is killed by its
// parent, or kills itself. No resident helper is needed (one would cost ~60 MB for
// the whole run); and the server must not hold the handle either, or a server
// crash would kill the worker at once instead of letting it stop gracefully.
//
// The script is passed with -EncodedCommand rather than as a .ps1 file because
// `tsc` does not copy assets into `out/`.

import { execFileSync } from 'child_process';
import * as path from 'path';

/** JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. */
const KILL_ON_JOB_CLOSE = 0x2000;
/**
 * JOB_OBJECT_LIMIT_BREAKAWAY_OK. Without it a tool that calls CreateProcess with
 * CREATE_BREAKAWAY_FROM_JOB fails with ACCESS_DENIED inside a hosted run; with it
 * such a deliberate breakaway escapes the job (documented in docs/server.md).
 */
const BREAKAWAY_OK = 0x800;

/** How long the helper may take (a cold Add-Type compile is ~0.4–2 s). */
const HELPER_TIMEOUT_MS = 20_000;

/**
 * The PowerShell source that puts `pid` into a new kill-on-close job object and
 * leaves the only job handle inside that process. Prints `ok` on success, or
 * `<step> <win32 error>` for the step that failed.
 */
export function JOB_KILL_ON_CLOSE_SCRIPT(pid: number): string {
  const flags = `0x${(KILL_ON_JOB_CLOSE | BREAKAWAY_OK).toString(16)}`;
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class MoagJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr th, uint acc, bool inh, uint opt);
  public static string Make(int pid) {
    IntPtr j = CreateJobObject(IntPtr.Zero, null); if (j == IntPtr.Zero) return "create " + Marshal.GetLastWin32Error();
    EXT e = new EXT(); e.Basic.LimitFlags = ${flags};
    if (!SetInformationJobObject(j, 9, ref e, (uint)Marshal.SizeOf(typeof(EXT)))) return "limits " + Marshal.GetLastWin32Error();
    IntPtr p = OpenProcess(0x0141, false, pid); if (p == IntPtr.Zero) return "open " + Marshal.GetLastWin32Error();
    IntPtr dup; if (!DuplicateHandle(GetCurrentProcess(), j, p, out dup, 0, false, 2)) return "dup " + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(j, p)) return "assign " + Marshal.GetLastWin32Error();
    return "ok";
  }
}
"@
[Console]::Out.Write([MoagJob]::Make(${pid}))`;
}

/** PowerShell arguments that run {@link JOB_KILL_ON_CLOSE_SCRIPT} for `pid`. */
export function jobHelperArgs(pid: number): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(JOB_KILL_ON_CLOSE_SCRIPT(pid), 'utf16le').toString('base64')];
}

export interface BindProcessTreeDeps {
  platform?: NodeJS.Platform;
  exec?: (file: string, args: string[]) => string;
  env?: NodeJS.ProcessEnv;
}

export type BindProcessTreeResult = { ok: true } | { ok: false; reason: string };

/**
 * Windows only: put process `pid` (default: this one) into a kill-on-close job
 * object so every process it starts from now on — including descendants whose
 * parent has exited — is terminated when `pid` exits, however it exits.
 *
 * Call it BEFORE starting any child: processes started earlier are not in the
 * job. Synchronous; never throws. On any other platform, or when PowerShell is
 * missing or restricted, returns `{ ok: false, reason }` and changes nothing.
 */
export function bindProcessTreeToLifetime(pid: number = process.pid, deps: BindProcessTreeDeps = {}): BindProcessTreeResult {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') { return { ok: false, reason: `not supported on ${platform}` }; }
  if (!Number.isInteger(pid) || pid <= 0) { return { ok: false, reason: `invalid pid ${String(pid)}` }; }
  const env = deps.env ?? process.env;
  const file = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Not detached: a detached PowerShell never answered in testing.
  const exec = deps.exec ?? ((f: string, args: string[]) => execFileSync(f, args, {
    encoding: 'utf-8', windowsHide: true, timeout: HELPER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  try {
    const out = String(exec(file, jobHelperArgs(pid)) ?? '').trim();
    if (out === 'ok') { return { ok: true }; }
    return { ok: false, reason: (out || 'no output from the job helper').slice(0, REASON_MAX) };
  } catch (err) {
    return { ok: false, reason: helperFailureReason(err) };
  }
}

/** Longest reason text the binder returns (it is shown on the run as a warning). */
const REASON_MAX = 200;

/**
 * Readable text from the helper's stderr. With `-EncodedCommand` PowerShell writes
 * its error stream as CLIXML (`#< CLIXML <Objs>…<S S="Error">…</S>…`), so the
 * error strings are pulled out and decoded; progress records are dropped. Plain
 * text passes through. Whitespace is collapsed; the result is capped at 200 chars.
 */
export function helperStderrText(stderr: unknown): string {
  const raw = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : typeof stderr === 'string' ? stderr : '';
  let text = raw;
  if (/^\s*#< CLIXML/.test(raw)) {
    const parts: string[] = [];
    const re = /<S S="Error">([\s\S]*?)<\/S>/g;
    for (let m = re.exec(raw); m; m = re.exec(raw)) { parts.push(m[1]); }
    text = parts.join(' ')
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_s, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

/**
 * The reason for a helper that threw. Built from the error's code, exit status or
 * signal and the start of stderr — never from `err.message`, which Node formats as
 * `Command failed: <powershell> … -EncodedCommand <~6 KB of base64>` and would
 * flood the run's warning.
 */
export function helperFailureReason(err: unknown): string {
  if (!err || typeof err !== 'object') { return `job helper failed: ${String(err).slice(0, REASON_MAX)}`; }
  const e = err as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown };
  const how: string[] = [];
  if (typeof e.code === 'string' && e.code) { how.push(e.code); }
  if (typeof e.status === 'number') { how.push(`exit ${e.status}`); }
  if (typeof e.signal === 'string' && e.signal) { how.push(`signal ${e.signal}`); }
  const head = `job helper failed${how.length ? ` (${how.join(', ')})` : ''}`;
  const detail = helperStderrText(e.stderr);
  return detail ? `${head}: ${detail}` : head;
}
