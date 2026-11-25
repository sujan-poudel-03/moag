// ─── `moag service`: start the daemon when Windows starts ───
//
// On a PC in local mode the daemon is what lets ONOSOO start runs, from a phone too. Left to a terminal
// window it stops with the window. `moag service install` registers a per-user Task Scheduler task that
// starts it at every logon, hidden, restarts it a minute after it fails, and keeps a log:
//
//   %LOCALAPPDATA%\moag\daemon-run.ps1   what the task runs (written by `install`)
//   %LOCALAPPDATA%\moag\daemon.log       its output (rotated to daemon.log.old past 5 MB)
//   %LOCALAPPDATA%\moag\daemon-home\     the folder it runs in: not the user's home and not MOAG's config
//                                        folder, so the device key never sits inside its working folder
//
// It runs as the signed-in user, at the user's own privilege (never elevated): the same account
// `moag daemon` would run as in a terminal. Windows only; elsewhere a service manager is the way
// (docs/onosoo-remote.md, "Running the daemon as a service"). Imports nothing that loads `vscode`.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TASK_NAME = 'MOAG Daemon';
const LOG_LIMIT_MB = 5;

export interface ServicePaths {
  dir: string;
  workDir: string;
  scriptPath: string;
  logPath: string;
  xmlPath: string;
}

/** Where the service keeps its files, from the injected environment (never from the working folder). */
export function servicePaths(env: NodeJS.ProcessEnv, homedir: () => string = os.homedir): ServicePaths {
  const local = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'moag');
  return {
    dir,
    workDir: path.join(dir, 'daemon-home'),
    scriptPath: path.join(dir, 'daemon-run.ps1'),
    logPath: path.join(dir, 'daemon.log'),
    xmlPath: path.join(dir, 'daemon-task.xml'),
  };
}

/** A string for inside single quotes in PowerShell. */
const psq = (s: string): string => s.replaceAll("'", "''");

/** A string for XML text. */
function xml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * The script the task runs: log, rotate, change to the working folder, run the daemon and pass its exit code
 * on, so that a failure is restarted and a clean stop is not.
 */
export function runnerScript(p: { node: string; cli: string; paths: ServicePaths }): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$log = '${psq(p.paths.logPath)}'`,
    `try { if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt ${LOG_LIMIT_MB}MB)) { Move-Item -LiteralPath $log "$log.old" -Force } } catch { }`,
    `Set-Location -LiteralPath '${psq(p.paths.workDir)}'`,
    `"[$(Get-Date -Format o)] moag daemon starting" | Out-File -FilePath $log -Append -Encoding utf8`,
    `& '${psq(p.node)}' '${psq(p.cli)}' daemon 2>&1 | ForEach-Object { $_.ToString() } | Out-File -FilePath $log -Append -Encoding utf8`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

/** The Task Scheduler definition: at logon of `user`, hidden window, unlimited run time, restart on failure. */
export function taskXml(p: { user: string; paths: ServicePaths }): string {
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${p.paths.scriptPath}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>MOAG daemon: lets ONOSOO start runs on this PC.</Description></RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(p.user)}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${xml(p.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>powershell.exe</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(p.paths.workDir)}</WorkingDirectory></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

export interface ExecResult { status: number | null; stdout: string; stderr: string }

export interface ServiceDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** The running program (`node`) and the CLI script it was started with. */
  node?: string;
  cli?: string;
  exec?: (file: string, args: string[]) => ExecResult;
  mkdir?: (dir: string) => void;
  /** Write a file (text, or UTF-16 for the task definition). */
  write?: (file: string, data: string | Buffer) => void;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

function defaultExec(file: string, args: string[]): ExecResult {
  const r = spawnSync(file, args, { encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const NOT_WINDOWS =
  'moag service is for Windows. On Linux, run the daemon under systemd (docs/onosoo-remote.md, "Running the daemon as a service"); on macOS, under launchd.\n';

const USAGE = 'Usage: moag service <install | uninstall | status>\n';

/** The system's schtasks, by full path: nothing a PATH entry could shadow. */
function schtasks(env: NodeJS.ProcessEnv): string {
  return path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
}

/** `moag service <install | uninstall | status>`. Returns the exit code. */
export function cmdService(verb: string | undefined, deps: ServiceDeps = {}): number {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((s: string): void => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string): void => { process.stderr.write(s); });
  if (platform !== 'win32') {
    err(NOT_WINDOWS);
    return 2;
  }
  if (verb !== 'install' && verb !== 'uninstall' && verb !== 'status') {
    err(USAGE);
    return 2;
  }
  const exec = deps.exec ?? defaultExec;
  const sch = schtasks(env);
  const paths = servicePaths(env, deps.homedir);

  if (verb === 'status') {
    const r = exec(sch, ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
    if (r.status !== 0) {
      out('Not installed. Run `moag service install` to start the daemon when Windows starts.\n');
      return 1;
    }
    const pick = (label: string): string => (new RegExp(`^${label}:\\s*(.*)$`, 'mi').exec(r.stdout)?.[1] ?? '').trim();
    out(`Installed: ${TASK_NAME}\n  Status:      ${pick('Status') || 'unknown'}\n  Last run:    ${pick('Last Run Time') || 'never'}\n  Last result: ${pick('Last Result') || 'unknown'}\n  Log:         ${paths.logPath}\n`);
    return 0;
  }

  if (verb === 'uninstall') {
    const r = exec(sch, ['/Delete', '/TN', TASK_NAME, '/F']);
    if (r.status !== 0) {
      out('Nothing to remove: the task is not installed.\n');
      return 0;
    }
    out('Removed. The daemon will no longer start with Windows. A daemon that is running now keeps running until you close it.\n');
    return 0;
  }

  // install
  const node = deps.node ?? process.execPath;
  const cli = deps.cli ?? (process.argv[1] ? path.resolve(process.argv[1]) : '');
  if (!cli) {
    err('Could not tell which MOAG script is running, so there is nothing to register. Run `moag service install` from the installed `moag` command.\n');
    return 1;
  }
  const stateDir = path.join(env.APPDATA || path.join((deps.homedir ?? os.homedir)(), 'AppData', 'Roaming'), 'moag');
  const rel = path.relative(stateDir.toLowerCase(), paths.workDir.toLowerCase());
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    err(`Refusing to install: the service's working folder (${paths.workDir}) would sit inside MOAG's config folder.\n`);
    return 1;
  }
  const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : (env.USERNAME ?? '');
  if (!user) {
    err('Could not tell which Windows user to run the service as (USERNAME is not set).\n');
    return 1;
  }

  const mkdir = deps.mkdir ?? ((d: string): void => { fs.mkdirSync(d, { recursive: true }); });
  const write = deps.write ?? ((f: string, data: string | Buffer): void => { fs.writeFileSync(f, data); });
  try {
    mkdir(paths.workDir);
    write(paths.scriptPath, runnerScript({ node, cli, paths }));
    // schtasks reads a task definition as UTF-16 with a byte order mark.
    write(paths.xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ user, paths }), 'utf16le')]));
  } catch (e) {
    err(`Could not write the service files under ${paths.dir}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const created = exec(sch, ['/Create', '/TN', TASK_NAME, '/XML', paths.xmlPath, '/F']);
  if (created.status !== 0) {
    err(`Windows refused to create the task: ${(created.stderr || created.stdout).trim() || `exit ${created.status}`}\n`);
    return 1;
  }
  const started = exec(sch, ['/Run', '/TN', TASK_NAME]);
  out(`Installed "${TASK_NAME}": the daemon now starts when you sign in to Windows, runs hidden, and restarts a minute after a failure.\n`);
  out(started.status === 0
    ? 'Started it now. Close any `moag daemon` window you have open, or it will hold the lock.\n'
    : `It will start at your next sign-in (starting it now failed: ${(started.stderr || started.stdout).trim() || `exit ${started.status}`}).\n`);
  out(`Log: ${paths.logPath}\nCheck it with: moag service status\n`);
  return 0;
}
