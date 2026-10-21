# MOAG - keep this Windows machine online in ONOSOO.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Install
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-windows.ps1 -Uninstall
#
# -Install registers a Scheduled Task named "MOAG daemon" for the CURRENT user only. It
# starts at your logon, runs hidden, needs no administrator rights, and runs
#
#   node <repo>\out\headless\cli.js daemon
#
# With the device key in %APPDATA%\moag\onosoo.json and no .moag\daemon.json, `moag daemon`
# is an ONOSOO poller only: on Windows it reports remote start as off and keeps the machine's
# last-seen fresh, so ONOSOO shows it Online. It never starts work on this machine.
#
# The key stays in onosoo.json. This script never reads it into the task's arguments or
# environment, and it never sets an environment variable.
#
# The daemon's output goes to %LOCALAPPDATA%\moag\daemon.log. If it exits with an error it
# is started again after a minute. Its working directory is %LOCALAPPDATA%\moag\daemon (not
# your profile folder: %APPDATA%\moag is inside the profile, and MOAG refuses to relay when its
# config folder is inside the working directory).
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
$Cli = Join-Path $Repo 'out\headless\cli.js'
$Script = Join-Path $PSScriptRoot 'install-daemon-windows.ps1'
$StateDir = Join-Path $env:LOCALAPPDATA 'moag'
$WorkDir = Join-Path $StateDir 'daemon'
$Log = Join-Path $StateDir 'daemon.log'
$OnosooFile = Join-Path $env:APPDATA 'moag\onosoo.json'
$RestartDelaySec = 60
$MaxLogBytes = 10MB

function Say($m) { Write-Host "  $m" }
function Fail($m) { [Console]::Error.WriteLine("  $m"); exit 1 }

function Write-Log($line) {
  try { [System.IO.File]::AppendAllText($Log, "$line`r`n", (New-Object System.Text.UTF8Encoding $false)) } catch { }
}

# The node and powershell processes this task started, found by their command lines.
function Get-DaemonProcesses {
  $cliNeedle = $Cli.ToLowerInvariant()
  $scriptNeedle = $Script.ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
    Where-Object {
      $cl = [string]$_.CommandLine
      $low = $cl.ToLowerInvariant()
      ($low.Contains($cliNeedle) -and $low.Contains(' daemon')) -or ($low.Contains($scriptNeedle) -and $low.Contains('-run'))
    }
}

# --- -Run: what the Scheduled Task runs -----------------------------------------------
if ($Run) {
  # Native stderr is merged into the log below; it must not stop this loop.
  $ErrorActionPreference = 'Continue'
  New-Item -ItemType Directory -Force $WorkDir | Out-Null
  Set-Location $WorkDir
  if (-not $Node) { $Node = 'node' }
  while ($true) {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt $MaxLogBytes) {
      Move-Item -Force $Log "$Log.1"
    }
    Write-Log "[$(Get-Date -Format o)] starting: $Node $Cli daemon --cwd $WorkDir"
    & $Node $Cli daemon --cwd $WorkDir 2>&1 | ForEach-Object { Write-Log "$_" }
    $code = $LASTEXITCODE
    Write-Log "[$(Get-Date -Format o)] moag daemon exited with code $code"
    if ($code -eq 0) { exit 0 }
    Write-Log "[$(Get-Date -Format o)] restarting in $RestartDelaySec s"
    Start-Sleep -Seconds $RestartDelaySec
  }
}

# --- -Install -------------------------------------------------------------------------
if ($Install) {
  if (-not (Test-Path $OnosooFile)) {
    Fail "No ONOSOO device key found: $OnosooFile does not exist. Pair this machine in ONOSOO (Builds > Pair machine) and save the key there first; see docs\onosoo-builds.md, Level 1, step 2."
  }
  if (-not (Test-Path $Cli)) {
    Fail "MOAG is not built: $Cli does not exist. Run 'npm install' and 'npm run compile' in $Repo first."
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
    -Description 'Keeps this machine online in ONOSOO (moag daemon, poller only). Installed by scripts\install-daemon-windows.ps1.'

  # A re-install replaces the task; stop the old daemon first so only one runs.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-DaemonProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
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
  # The wrapper first, so it cannot start node again; then node itself.
  $procs = @(Get-DaemonProcesses | Sort-Object { if ($_.Name -eq 'node.exe') { 1 } else { 0 } })
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($procs.Count -gt 0) { Say "Stopped $($procs.Count) daemon process(es)." }
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
$running = @(Get-DaemonProcesses | Where-Object { $_.Name -eq 'node.exe' })
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
