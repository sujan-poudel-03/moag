param([switch]$Watch)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$extBase = Join-Path $env:USERPROFILE '.vscode\extensions'
$extDir  = Get-ChildItem $extBase -Directory |
           Where-Object { $_.Name -like 'moag.agent-task-player-*' } |
           Sort-Object Name -Descending |
           Select-Object -First 1 -ExpandProperty FullName

if (-not $extDir) {
    Write-Host ''
    Write-Host '  No installed MOAG extension found in:' -ForegroundColor Yellow
    Write-Host "  $extBase" -ForegroundColor Yellow
    Write-Host '  Install the VSIX first, then use this script for incremental deploys.' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host "  Target  : $extDir" -ForegroundColor DarkGray

function Deploy-Now {
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host ''
    Write-Host "  [$ts] Compiling..." -NoNewline -ForegroundColor Cyan

    Push-Location $root
    $out = & npm run compile 2>&1
    $ok  = $LASTEXITCODE -eq 0
    Pop-Location

    if (-not $ok) {
        Write-Host ' FAILED' -ForegroundColor Red
        $out | Select-String 'error' | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        return
    }
    Write-Host ' OK' -ForegroundColor Green

    Write-Host '  Syncing out/ ...' -NoNewline -ForegroundColor Cyan
    $null = robocopy "$root\out" "$extDir\out" /MIR /NFL /NDL /NJH /NJS
    Write-Host ' OK' -ForegroundColor Green

    Copy-Item "$root\package.json" "$extDir\package.json" -Force

    $sdkSrc = "$root\node_modules\@anthropic-ai"
    if (Test-Path $sdkSrc) {
        Write-Host '  Syncing @anthropic-ai/sdk ...' -NoNewline -ForegroundColor Cyan
        $sdkDest = "$extDir\node_modules\@anthropic-ai"
        New-Item -ItemType Directory -Force -Path $sdkDest | Out-Null
        $null = robocopy $sdkSrc $sdkDest /MIR /NFL /NDL /NJH /NJS
        Write-Host ' OK' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host '  Done. Reload each VS Code window:' -ForegroundColor Green
    Write-Host '  Ctrl+Shift+P -> Reload Window' -ForegroundColor Cyan
    Write-Host ''
}

if ($Watch) {
    Write-Host '  Watch mode — deploy on every .ts save. Ctrl+C to stop.' -ForegroundColor Cyan
    Deploy-Now

    $lastDeploy = Get-Date
    while ($true) {
        Start-Sleep -Milliseconds 800
        $changed = Get-ChildItem "$root\src" -Recurse -Filter '*.ts' |
                   Where-Object { $_.LastWriteTime -gt $lastDeploy }
        if ($changed) {
            $lastDeploy = Get-Date
            Start-Sleep -Milliseconds 400
            Deploy-Now
        }
    }
} else {
    Deploy-Now
}
