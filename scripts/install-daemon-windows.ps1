# MOAG - keep this Windows machine online in ONOSOO.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Uninstall
#
# It runs from a MOAG checkout (scripts\ next to out\), or from %LOCALAPPDATA%\moag\bin, where
# "MOAG: Install Command-Line Tool" copies it next to moag-launch.js.
#
# -Install registers a Scheduled Task named "MOAG daemon" for the CURRENT user only. It
# starts at your logon, runs hidden, needs no administrator rights, and runs
#
#   node <repo>\out\headless\cli.js daemon        (a checkout)
#   node <bin>\moag-launch.js daemon            (installed: the newest installed extension's CLI)
#
# With the device key in %APPDATA%\moag\onosoo.json and no .moag\daemon.json, `moag daemon`
# is an ONOSOO poller only: on Windows it reports remote start as off and keeps the machine's
# last-seen fresh, so ONOSOO shows it Online. It never starts work on this machine.
#
# The key stays in onosoo.json. This script never reads it into the task's arguments or
# environment, and it never sets an environment variable.
#
# The daemon's output goes to %LOCALAPPDATA%\moag\daemon.log (moved to daemon.log.1 past
# 10 MB). If it exits with an error it is started again after a minute, but after 5 failures
# within 10 minutes (a configuration error, say) it stops trying and says so in the log. Its
# working directory is %LOCALAPPDATA%\moag\daemon (not your profile folder: %APPDATA%\moag is
# inside the profile, and MOAG refuses to relay when its config folder is inside the working
# directory).
#
# -Install, -Uninstall and -Status touch only this task's own processes: a `moag daemon` you
# started by hand keeps running.
#
# -Run is internal: it is what the Scheduled Task runs.
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Status')][switch]$Status,
  [Parameter(ParameterSetName = 'Run', Mandatory = $true)][switch]$Run,
  [Parameter(ParameterSetName = 'Run')][string]$Node
)
$ErrorActionPreference = 'Stop'

$TaskName = 'MOAG daemon'
$Repo = Split-Path $PSScriptRoot -Parent
$Launcher = Join-Path $PSScriptRoot 'moag-launch.js'

# Which CLI to run, resolved again at every (re)start so an update is picked up:
#   1. a checkout: out\headless\cli.js;
#   2. the installed copy: moag-launch.js next to this script (%LOCALAPPDATA%\moag\bin),
#      which runs the newest installed extension's CLI.
# $null when neither exists.
function Resolve-MoagCli {
  $checkout = Join-Path $Repo 'out\headless\cli.js'
  if (Test-Path $checkout) { return $checkout }
  if (Test-Path $Launcher) { return $Launcher }
  return $null
}
$Cli = Resolve-MoagCli
$Script = Join-Path $PSScriptRoot 'install-daemon-windows.ps1'
$StateDir = Join-Path $env:LOCALAPPDATA 'moag'
$WorkDir = Join-Path $StateDir 'daemon'
$Log = Join-Path $StateDir 'daemon.log'
$OnosooFile = Join-Path $env:APPDATA 'moag\onosoo.json'
$RestartDelaySec = 60
$MaxLogBytes = 10MB
$MaxFailures = 5
$FailureWindowSec = 600

function Say($m) { Write-Host "  $m" }
function Fail($m) { [Console]::Error.WriteLine("  $m"); exit 1 }

function Write-Log($line) {
  try { [System.IO.File]::AppendAllText($Log, "$line`r`n", (New-Object System.Text.UTF8Encoding $false)) } catch { }
}

# Move a log past $MaxLogBytes to daemon.log.1 (one generation is kept). Never throws.
function Invoke-LogRotate {
  try {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt $MaxLogBytes) { Move-Item -Force $Log "$Log.1" }
  } catch { }
}

# The Scheduled Task's own wrapper: powershell running THIS script with -Run, as the task's
# action starts it (-File "<script>" -Run). Nothing else matches.
function Get-DaemonWrappers {
  $needle = ('-File "' + $Script + '" -Run').ToLowerInvariant()
  @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
    Where-Object { ([string]$_.CommandLine).ToLowerInvariant().Contains($needle) })
}

# The Scheduled Task's own node: a MOAG CLI (a checkout's cli.js, or the installed
# moag-launch.js) with exactly `daemon --cwd <WorkDir>` (%LOCALAPPDATA%\moag\daemon). WorkDir is
# the discriminator: only the task uses it, so a `moag daemon --cwd <project>` started by hand
# never matches.
function Get-DaemonNodes {
  $cliNeedles = @('\out\headless\cli.js', '\moag-launch.js')
  if ($Cli) { $cliNeedles += $Cli.ToLowerInvariant() }
  $cwdPattern = '\sdaemon\s+--cwd\s+"?' + [regex]::Escape($WorkDir.ToLowerInvariant()) + '"?\s*$'
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $low = ([string]$_.CommandLine).ToLowerInvariant()
      $isCli = @($cliNeedles | Where-Object { $low.Contains($_) }).Count -gt 0
      $isCli -and ($low -match $cwdPattern)
    })
}

# Stop the task's wrapper with its process tree (so it cannot start node again), then any node
# of the task left without its wrapper. Returns how many processes were found.
function Stop-DaemonProcesses {
  $wrappers = Get-DaemonWrappers
  foreach ($w in $wrappers) { & taskkill.exe /PID $w.ProcessId /T /F 2>&1 | Out-Null }
  $orphans = Get-DaemonNodes
  foreach ($n in $orphans) { Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue }
  return ($wrappers.Count + $orphans.Count)
}

# --- -Run: what the Scheduled Task runs -----------------------------------------------
if ($Run) {
  # Native stderr is merged into the log below; it must not stop this loop.
  $ErrorActionPreference = 'Continue'
  New-Item -ItemType Directory -Force $WorkDir | Out-Null
  Set-Location $WorkDir
  if (-not $Node) { $Node = 'node' }
  $failures = @()
  while ($true) {
    Invoke-LogRotate
    # Resolved on every start: an extension update moves the CLI.
    $Cli = Resolve-MoagCli
    if (-not $Cli) {
      Write-Log "[$(Get-Date -Format o)] MOAG is not installed: run 'MOAG: Install Command-Line Tool' in VS Code. Not restarting."
      exit 0
    }
    Write-Log "[$(Get-Date -Format o)] starting: $Node $Cli daemon --cwd $WorkDir"
    # Rotation is also checked every 500 lines, so a chatty daemon cannot grow the log unbounded.
    $lines = 0
    & $Node $Cli daemon --cwd $WorkDir 2>&1 | ForEach-Object {
      Write-Log "$_"
      $lines++
      if ($lines % 500 -eq 0) { Invoke-LogRotate }
    }
    $code = $LASTEXITCODE
    Write-Log "[$(Get-Date -Format o)] moag daemon exited with code $code"
    if ($code -eq 0) { exit 0 }
    $now = Get-Date
    $failures = @(@($failures) + $now | Where-Object { ($now - $_).TotalSeconds -le $FailureWindowSec })
    if ($failures.Count -ge $MaxFailures) {
      Write-Log "[$(Get-Date -Format o)] GIVING UP: moag daemon failed $($failures.Count) times within $($FailureWindowSec / 60) minutes (last exit code $code) and is not restarted again. Fix the error above (exit code 2 is a configuration error), then run this script with -Install again."
      # Exit 0 on purpose: the task's own restart-on-failure must not start the loop again.
      exit 0
    }
    Write-Log "[$(Get-Date -Format o)] restarting in $RestartDelaySec s"
    Start-Sleep -Seconds $RestartDelaySec
  }
}

# --- -Install -------------------------------------------------------------------------
if ($Install) {
  if (-not (Test-Path $OnosooFile)) {
    Fail "No ONOSOO device key found: $OnosooFile does not exist. Pair this machine in ONOSOO (Builds > Pair machine) and save the key there first; see docs\onosoo-builds.md, Level 1, step 2."
  }
  if (-not $Cli) {
    Fail "MOAG is not installed: run 'MOAG: Install Command-Line Tool' in VS Code (or, in a checkout, 'npm install' and 'npm run compile' in $Repo)."
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { Fail 'node not found on PATH. Install Node.js 20 first (https://nodejs.org).' }
  $nodePath = $nodeCmd.Source

  New-Item -ItemType Directory -Force $WorkDir | Out-Null

  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $psArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -Run -Node `"$nodePath`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $WorkDir
  # A logon trigger for this user only, and a Limited (non-elevated) principal: no admin needed.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Keeps this machine online in ONOSOO (moag daemon, poller only). Installed by install-daemon-windows.ps1.'

  # A re-install replaces the task; stop the old task's daemon first so only one runs.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    [void](Stop-DaemonProcesses)
  }
  try {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  } catch {
    Fail "Could not register the '$TaskName' task for $userId : $($_.Exception.Message)"
  }
  Start-ScheduledTask -TaskName $TaskName
  Say "Installed '$TaskName' for $userId (runs at logon, hidden, no admin)."
  Say "Started it now. Log: $Log"
  Say 'Check it with: -Status'
  exit 0
}

# --- -Uninstall -----------------------------------------------------------------------
if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say "Removed '$TaskName'."
  } else {
    Say "'$TaskName' is not installed."
  }
  # Only the task's own processes; a moag daemon started by hand keeps running.
  $stopped = Stop-DaemonProcesses
  if ($stopped -gt 0) { Say "Stopped the task's daemon ($stopped process(es) found)." }
  Say "The log is kept: $Log"
  exit 0
}

# --- -Status (the default) -------------------------------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Say "'$TaskName' is not installed. Install it with -Install."
} else {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Say "Task        : $TaskName ($($task.State))"
  Say "Runs as     : $($task.Principal.UserId)"
  Say "Last run    : $($info.LastRunTime) (result $($info.LastTaskResult))"
}
$running = Get-DaemonNodes
if ($running.Count -gt 0) {
  Say "Daemon      : running (pid $(($running | ForEach-Object { $_.ProcessId }) -join ', '))"
} else {
  Say 'Daemon      : not running'
}
Say "Device key  : $(if (Test-Path $OnosooFile) { "$OnosooFile (present)" } else { "$OnosooFile (MISSING)" })"
Say "Log         : $Log"
if (Test-Path $Log) {
  Say 'Last lines  :'
  Get-Content $Log -Tail 5 | ForEach-Object { Say "  $_" }
}
exit 0
