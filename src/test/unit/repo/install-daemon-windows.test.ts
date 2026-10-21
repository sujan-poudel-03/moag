// ─── scripts/install-daemon-windows.ps1: keep a Windows machine online in ONOSOO ───
//
// The script registers a per-user Scheduled Task that runs `moag daemon`. The device key must
// never reach the task's arguments or environment, nor any account-wide variable, so the
// script is checked statically; on Windows it is also parsed and its refusal path is run.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'install-daemon-windows.ps1');

/** The script with its `#` comment lines dropped, so prose cannot mask (or fake) a check. */
function code(text: string): string {
  return text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
}

describe('scripts/install-daemon-windows.ps1', () => {
  const text = fs.readFileSync(SCRIPT, 'utf-8');
  const body = code(text);

  it('never references the device key variable, anywhere in the file', () => {
    assert.ok(!/MOAG_ONOSOO_KEY/i.test(text));
    assert.ok(!/MOAG_ONOSOO_URL/i.test(text));
  });

  it('sets no environment variable: no setx, no SetEnvironmentVariable, no $env: assignment, no task environment', () => {
    assert.ok(!/\bsetx\b/i.test(body), 'setx');
    assert.ok(!/SetEnvironmentVariable/i.test(body), 'SetEnvironmentVariable');
    assert.ok(!/\$env:[A-Za-z_]+\s*=(?!=)/.test(body), '$env: assignment');
    assert.ok(!/HKCU:\\Environment|HKLM:.*Environment/i.test(body), 'registry environment');
  });

  it('never reads the key out of onosoo.json (it only checks the file exists)', () => {
    assert.ok(!/Get-Content[^\n]*OnosooFile/i.test(body));
    assert.ok(!/ConvertFrom-Json/i.test(body));
    assert.ok(/Test-Path \$OnosooFile/.test(body));
  });

  it('registers a per-user, non-elevated logon task named "MOAG daemon"', () => {
    assert.ok(body.includes("$TaskName = 'MOAG daemon'"));
    assert.ok(/New-ScheduledTaskTrigger -AtLogOn -User \$userId/.test(body), 'logon trigger for this user only');
    assert.ok(/-LogonType Interactive -RunLevel Limited/.test(body), 'limited (no admin) principal');
    assert.ok(!/RunLevel Highest/i.test(body), 'never elevated');
    assert.ok(!/-LogonType (S4U|Password|ServiceAccount)/i.test(body), 'no stored credentials');
    assert.ok(/ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(body), 'no 72 h default time limit');
    assert.ok(/-RestartCount \d+ -RestartInterval/.test(body), 'restarts on failure');
    assert.ok(/-WindowStyle Hidden/.test(body), 'hidden window');
  });

  it('runs `node <repo>\\out\\headless\\cli.js daemon`, outside the profile, logging to %LOCALAPPDATA%\\moag\\daemon.log', () => {
    assert.ok(body.includes("Join-Path $Repo 'out\\headless\\cli.js'"));
    assert.ok(/& \$Node \$Cli daemon --cwd \$WorkDir/.test(body));
    assert.ok(body.includes("Join-Path $env:LOCALAPPDATA 'moag'"));
    assert.ok(body.includes("Join-Path $StateDir 'daemon.log'"));
    assert.ok(body.includes("Join-Path $env:APPDATA 'moag\\onosoo.json'"));
  });

  it('checks onosoo.json before it builds or registers anything', () => {
    const check = body.indexOf('Test-Path $OnosooFile');
    assert.ok(check > 0);
    assert.ok(check < body.indexOf('Register-ScheduledTask'));
    assert.ok(check < body.indexOf('New-ScheduledTaskAction'));
  });

  it('matches only the task\'s own processes: the -Run wrapper of this script, and node with exactly --cwd $WorkDir', () => {
    assert.ok(!/Get-DaemonProcesses/.test(body), 'the broad " daemon" matcher is gone');
    assert.ok(body.includes(`$needle = ('-File "' + $Script + '" -Run').ToLowerInvariant()`), 'the wrapper is matched by its -File "<script>" -Run');
    assert.ok(body.includes(`[regex]::Escape($WorkDir.ToLowerInvariant())`), 'node is matched by the exact work dir');
    assert.ok(/'"\?\\s\*\$'/.test(body), 'the --cwd value must end the command line (no prefix match)');
    assert.ok(!/low\.Contains\(' daemon'\)/.test(body), 'no bare " daemon" substring match');
  });

  it('kills the wrapper\'s process tree, and -Status reports only the task\'s node', () => {
    assert.ok(/taskkill\.exe \/PID \$w\.ProcessId \/T \/F/.test(body), 'the wrapper is killed with its tree');
    assert.ok(/\$running = Get-DaemonNodes/.test(body), '-Status counts the task\'s node only');
    const install = body.slice(body.indexOf('if ($Install) {'), body.indexOf('if ($Uninstall) {'));
    const uninstall = body.slice(body.indexOf('if ($Uninstall) {'), body.indexOf('-Status (the default)'));
    for (const block of [install, uninstall]) {
      assert.ok(block.includes('Stop-DaemonProcesses'));
      assert.ok(!/Stop-Process/.test(block), 'no other kill path');
    }
  });

  it('stops restarting after 5 failures within 10 minutes, with a clear log line', () => {
    assert.ok(body.includes('$MaxFailures = 5'));
    assert.ok(body.includes('$FailureWindowSec = 600'));
    assert.ok(/\$failures\.Count -ge \$MaxFailures/.test(body));
    assert.ok(/Write-Log "[^"]*GIVING UP: moag daemon failed/.test(body));
    const run = body.slice(body.indexOf('if ($Run) {'), body.indexOf('if ($Install) {'));
    const giveUp = run.indexOf('GIVING UP');
    assert.ok(giveUp > 0 && giveUp < run.indexOf('Start-Sleep -Seconds $RestartDelaySec'), 'it gives up before sleeping to restart');
  });

  it('rotates the log before each start and every 500 lines while the daemon runs', () => {
    const run = body.slice(body.indexOf('if ($Run) {'), body.indexOf('if ($Install) {'));
    assert.ok(run.indexOf('Invoke-LogRotate') < run.indexOf('& $Node $Cli daemon'), 'before each (re)start');
    assert.ok(/if \(\$lines % 500 -eq 0\) \{ Invoke-LogRotate \}/.test(run), 'periodically while running');
    assert.ok(/Length -gt \$MaxLogBytes\) \{ Move-Item -Force \$Log "\$Log\.1" \}/.test(body));
  });

  it('is ASCII only (Windows PowerShell 5.1 misreads a BOM-less UTF-8 script)', () => {
    assert.ok([...text].every((c) => c.charCodeAt(0) < 128));
  });

  describe('on Windows', function () {
    this.timeout(60_000);
    before(function () { if (process.platform !== 'win32') { this.skip(); } });

    function ps(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } | null {
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
        { env, encoding: 'utf-8', windowsHide: true, timeout: 45_000 });
      if (r.error && /EPERM|ENOENT/i.test(r.error.message)) { return null; }
      if (r.error) { throw r.error; }
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    it('parses with no errors', function () {
      const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}',[ref]$t,[ref]$e);$e.Count`;
      const r = ps(['-Command', cmd], process.env);
      if (!r) { this.skip(); }
      assert.equal(r!.stdout.trim(), '0', r!.stderr);
    });

    it('the process matchers find the task\'s wrapper and node, never a hand-started moag daemon', function () {
      // The script's own two matcher functions, run against a faked Get-CimInstance (a function
      // shadows the cmdlet), with this machine's real paths.
      const start = text.indexOf('function Get-DaemonWrappers');
      const end = text.indexOf('# Stop the task\'s wrapper');
      assert.ok(start > 0 && end > start);
      const fns = text.slice(start, end);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-psmatch-'));
      const probe = path.join(dir, 'probe.ps1');
      fs.writeFileSync(probe, [
        `$Script = 'C:\\r\\scripts\\install-daemon-windows.ps1'`,
        `$Cli = 'C:\\r\\out\\headless\\cli.js'`,
        `$WorkDir = 'C:\\Users\\A B\\AppData\\Local\\moag\\daemon'`,
        'function Get-CimInstance {',
        '  param($ClassName, $Filter)',
        '  @(',
        `    [pscustomobject]@{ ProcessId = 1; Name = 'powershell.exe'; CommandLine = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\r\\scripts\\install-daemon-windows.ps1" -Run -Node "C:\\n\\node.exe"' },`,
        `    [pscustomobject]@{ ProcessId = 2; Name = 'powershell.exe'; CommandLine = 'powershell.exe -File "C:\\r\\scripts\\install-daemon-windows.ps1" -Status' },`,
        `    [pscustomobject]@{ ProcessId = 3; Name = 'node.exe'; CommandLine = '"C:\\n\\node.exe" C:\\r\\out\\headless\\cli.js daemon --cwd "C:\\Users\\A B\\AppData\\Local\\moag\\daemon"' },`,
        `    [pscustomobject]@{ ProcessId = 4; Name = 'node.exe'; CommandLine = 'node C:\\r\\out\\headless\\cli.js daemon --cwd D:\\proj' },`,
        `    [pscustomobject]@{ ProcessId = 5; Name = 'node.exe'; CommandLine = 'node C:\\r\\out\\headless\\cli.js daemon --cwd "C:\\Users\\A B\\AppData\\Local\\moag\\daemon\\sub"' },`,
        `    [pscustomobject]@{ ProcessId = 6; Name = 'node.exe'; CommandLine = 'node C:\\other\\out\\headless\\cli.js daemon --cwd "C:\\Users\\A B\\AppData\\Local\\moag\\daemon"' },`,
        `    [pscustomobject]@{ ProcessId = 7; Name = 'node.exe'; CommandLine = 'node C:\\r\\out\\headless\\cli.js daemon' }`,
        '  )',
        '}',
        fns,
        `Write-Output ("W=" + ((Get-DaemonWrappers | ForEach-Object { $_.ProcessId }) -join ','))`,
        `Write-Output ("N=" + ((Get-DaemonNodes | ForEach-Object { $_.ProcessId }) -join ','))`,
      ].join('\r\n'));
      const r = ps(['-File', probe], process.env);
      if (!r) { this.skip(); }
      assert.equal(r!.status, 0, r!.stderr);
      const out = r!.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      assert.deepEqual(out, ['W=1', 'N=3']);
    });

    it('-Install refuses, with a clear message and exit 1, when %APPDATA%\\moag\\onosoo.json does not exist', function () {
      const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-noappdata-'));
      const r = ps(['-File', SCRIPT, '-Install'], { ...process.env, APPDATA: appData });
      if (!r) { this.skip(); }
      assert.equal(r!.status, 1, r!.stdout + r!.stderr);
      assert.match(r!.stderr, /No ONOSOO device key found: .*onosoo\.json does not exist/);
      assert.ok(!fs.existsSync(path.join(appData, 'moag')), 'nothing created');
    });
  });
});
