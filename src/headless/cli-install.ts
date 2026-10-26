// ─── Install Command-Line Tool — plan, write, PATH ───
//
// Puts a `moag` command on the user's machine that runs the CLI bundled in the
// installed extension. Three files:
//
//   shim         moag.cmd (Windows) or an sh script (macOS / Linux) on PATH
//   launcher     moag-launch.js, copied out of the extension; at run time it
//                picks the newest installed extension folder (moag-launch.ts)
//   config       moag-shim.json next to the launcher: where to look
//
//   Windows   %LOCALAPPDATA%\moag\bin\{moag.cmd, moag-launch.js, moag-shim.json, install-daemon-windows.ps1}
//   elsewhere ~/.local/bin/moag  and  ~/.local/share/moag/{moag-launch.js, moag-shim.json}
//
// The shim prefers `node` on PATH and falls back to VS Code's own runtime
// (ELECTRON_RUN_AS_NODE=1 with the executable recorded at install).
//
// The Windows user PATH is updated through the registry by PowerShell, run with
// no shell and the folder passed in an environment variable. Never `setx`: it
// truncates PATH at 1,024 characters. vscode-free.

import * as fs from 'fs';
import * as path from 'path';
import { execFileAsync } from '../utils/exec-file';
import { cliPathIn, LaunchConfig } from './moag-launch';

export interface InstallPlanInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The running extension's folder (context.extensionPath). */
  extensionPath: string;
  /** The VS Code executable (process.execPath in the extension host). */
  execPath: string;
}

export interface InstallPlan {
  platform: NodeJS.Platform;
  /** The folder that must be on PATH. */
  binDir: string;
  shimPath: string;
  launcherDest: string;
  configPath: string;
  extensionsDirs: string[];
  fixedCli: string;
  execPath: string;
  /** PATH as the installing process saw it. */
  pathEnv: string;
}

export interface InstallResult {
  written: string[];
  /** True when binDir is already on PATH (case-insensitive on Windows). */
  onPath: boolean;
}

const LAUNCHER = 'moag-launch.js';
const CONFIG = 'moag-shim.json';
const DAEMON_PS1 = 'install-daemon-windows.ps1';

/** Where every file goes, for this platform. Pure. */
export function planInstall(i: InstallPlanInput): InstallPlan {
  const P = i.platform === 'win32' ? path.win32 : path.posix;
  const extensionsDirs = [P.dirname(i.extensionPath)];
  const fixedCli = cliPathIn(i.extensionPath, fs);
  const pathEnv = i.env.PATH ?? i.env.Path ?? '';
  if (i.platform === 'win32') {
    const local = i.env.LOCALAPPDATA || P.join(i.homedir, 'AppData', 'Local');
    const binDir = P.join(local, 'moag', 'bin');
    return {
      platform: i.platform, binDir,
      shimPath: P.join(binDir, 'moag.cmd'),
      launcherDest: P.join(binDir, LAUNCHER),
      configPath: P.join(binDir, CONFIG),
      extensionsDirs, fixedCli, execPath: i.execPath, pathEnv,
    };
  }
  const binDir = P.join(i.homedir, '.local', 'bin');
  const share = P.join(i.homedir, '.local', 'share', 'moag');
  return {
    platform: i.platform, binDir,
    shimPath: P.join(binDir, 'moag'),
    launcherDest: P.join(share, LAUNCHER),
    configPath: P.join(share, CONFIG),
    extensionsDirs, fixedCli, execPath: i.execPath, pathEnv,
  };
}

/** cmd.exe treats % as a variable marker even inside quotes. */
function cmdQuote(s: string): string {
  return `"${s.replace(/%/g, '%%').replace(/"/g, '')}"`;
}

/**
 * The Windows shim. Labels, not parenthesised blocks, so %ERRORLEVEL% is read
 * after the launcher exits rather than when the block is parsed.
 */
export function renderCmdShim(execPath: string): string {
  return [
    '@echo off',
    'rem MOAG command-line tool, written by "MOAG: Install Command-Line Tool".',
    'setlocal',
    'where node >nul 2>nul',
    'if errorlevel 1 goto vscode',
    'node "%~dp0moag-launch.js" %*',
    'goto done',
    ':vscode',
    `if not exist ${cmdQuote(execPath)} goto noruntime`,
    'set ELECTRON_RUN_AS_NODE=1',
    `${cmdQuote(execPath)} "%~dp0moag-launch.js" %*`,
    'goto done',
    ':noruntime',
    `echo Node.js is not on PATH, and VS Code is no longer at ${execPath.replace(/%/g, '%%')}. Install Node.js, or run "MOAG: Install Command-Line Tool" again. 1>&2`,
    'exit /b 2',
    ':done',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** Single-quote for sh: every ' becomes '\''. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The macOS / Linux shim. */
export function renderShShim(launcherAbs: string, execPath: string): string {
  return [
    '#!/bin/sh',
    '# MOAG command-line tool, written by "MOAG: Install Command-Line Tool".',
    'if command -v node >/dev/null 2>&1; then',
    `  exec node ${shQuote(launcherAbs)} "$@"`,
    'fi',
    `if [ -x ${shQuote(execPath)} ]; then`,
    `  ELECTRON_RUN_AS_NODE=1 exec ${shQuote(execPath)} ${shQuote(launcherAbs)} "$@"`,
    'fi',
    `echo "Node.js is not on PATH, and VS Code is no longer at the path recorded at install. Install Node.js, or run 'MOAG: Install Command-Line Tool' again." >&2`,
    'exit 2',
    '',
  ].join('\n');
}

/** True when `dir` is one of the PATH entries (case-insensitive on Windows). */
export function isOnPath(dir: string, pathEnv: string, platform: NodeJS.Platform): boolean {
  const win = platform === 'win32';
  const norm = (p: string): string => {
    let s = p.trim().replace(/^"|"$/g, '');
    if (win) { s = s.replace(/\//g, '\\'); }
    while (s.length > 1 && /[\\/]$/.test(s)) { s = s.slice(0, -1); }
    return win ? s.toLowerCase() : s;
  };
  const target = norm(dir);
  return pathEnv.split(win ? ';' : ':').some((p) => p.trim() !== '' && norm(p) === target);
}

/**
 * Copy the launcher (and the daemon script on Windows), write the config and
 * the shim. Throws on a failed write; the caller reports it.
 */
export function writeInstall(plan: InstallPlan, srcLauncher: string, srcDaemonPs1?: string): InstallResult {
  const written: string[] = [];
  fs.mkdirSync(plan.binDir, { recursive: true });
  fs.mkdirSync(path.dirname(plan.launcherDest), { recursive: true });

  fs.copyFileSync(srcLauncher, plan.launcherDest);
  written.push(plan.launcherDest);

  const cfg: LaunchConfig = { extensionsDirs: plan.extensionsDirs, fixedCli: plan.fixedCli };
  fs.writeFileSync(plan.configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  written.push(plan.configPath);

  if (plan.platform === 'win32') {
    fs.writeFileSync(plan.shimPath, renderCmdShim(plan.execPath), 'utf-8');
  } else {
    fs.writeFileSync(plan.shimPath, renderShShim(plan.launcherDest, plan.execPath), { encoding: 'utf-8', mode: 0o755 });
    fs.chmodSync(plan.shimPath, 0o755);
  }
  written.push(plan.shimPath);

  if (plan.platform === 'win32' && srcDaemonPs1 && fs.existsSync(srcDaemonPs1)) {
    const dest = path.join(plan.binDir, DAEMON_PS1);
    fs.copyFileSync(srcDaemonPs1, dest);
    written.push(dest);
  }
  return { written, onPath: isOnPath(plan.binDir, plan.pathEnv, plan.platform) };
}

/**
 * Appends $env:MOAG_BIN_DIR to the user PATH in HKCU\Environment. Reads the raw
 * value (unexpanded, so %USERPROFILE%-style entries survive), skips a folder
 * already present, writes REG_EXPAND_SZ, and broadcasts WM_SETTINGCHANGE so
 * new processes see it. The folder is never interpolated into the script.
 */
export const WINDOWS_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$dir = $env:MOAG_BIN_DIR
if ([string]::IsNullOrWhiteSpace($dir)) { exit 3 }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($cur -split ';' | Where-Object { $_ -ne '' })
  $want = $dir.TrimEnd('\')
  if (@($parts | Where-Object { $_.TrimEnd('\') -ieq $want }).Count -gt 0) { exit 0 }
  $new = (@($parts) + $dir) -join ';'
  $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally {
  $key.Close()
}
Add-Type -Namespace MoagPath -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$result = [UIntPtr]::Zero
[void][MoagPath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
exit 0
`;

/** Add `binDir` to the Windows user PATH. Resolves true on success; never throws. */
export async function addToWindowsUserPath(binDir: string, exec: typeof execFileAsync = execFileAsync): Promise<boolean> {
  try {
    const r = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PATH_SCRIPT],
      { env: { ...process.env, MOAG_BIN_DIR: binDir }, timeoutMs: 30_000 },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
