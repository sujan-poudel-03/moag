# MOAG — build, package, and (re)install the extension into VS Code on Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -App
#
# Updates the installed MOAG extension to the current source. VS Code itself
# auto-updates; pass -App to attempt an app upgrade via winget/choco.
param([switch]$App)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Say($m) { Write-Host "  $m" }

# ── Ensure npm is available ──
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm not found. Install Node.js 18+ first (https://nodejs.org)."
}

# ── Locate the VS Code CLI (PATH, then standard install locations) ──
function Find-Code {
  foreach ($c in 'code','code-insiders','codium') {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}
$code = Find-Code
if (-not $code) { throw "VS Code CLI ('code') not found on PATH or in standard install locations." }
Say "VS Code CLI : $code"

# ── Build ──
if (-not (Test-Path 'node_modules')) { Say 'Installing dependencies...'; npm install }
Say 'Compiling...'; npm run compile

# ── Package VSIX ──
$version = node -p "require('./package.json').version"
$vsix = "agent-task-player-$version.vsix"
Say "Packaging $vsix..."
npx --yes vsce package --no-dependencies --allow-missing-repository --skip-license -o $vsix

# ── Install / update the extension ──
Say 'Installing extension into VS Code...'
& $code --install-extension $vsix --force

# ── Optional: update the VS Code app itself ──
if ($App) {
  Say 'Attempting VS Code app update (best-effort)...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget upgrade --id Microsoft.VisualStudioCode --silent --accept-source-agreements --accept-package-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco upgrade vscode -y
  } else {
    Say 'Neither winget nor choco found — update VS Code via its in-app updater.'
  }
}

Write-Host ''
Say "Done. Installed MOAG $version. Reload VS Code (Ctrl+Shift+P -> 'Reload Window') to activate."
