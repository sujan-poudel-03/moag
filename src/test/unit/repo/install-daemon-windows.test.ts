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
