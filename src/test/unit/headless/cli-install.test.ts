import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  addToWindowsUserPath, isOnPath, planInstall, renderCmdShim, renderShShim, WINDOWS_PATH_SCRIPT, writeInstall,
} from '../../../headless/cli-install';
import type { ExecFileAsyncResult } from '../../../utils/exec-file';

describe('Install Command-Line Tool: installer core', () => {
  describe('planInstall', () => {
    it('win32: everything in %LOCALAPPDATA%\\moag\\bin', () => {
      const p = planInstall({
        platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', PATH: 'C:\\Windows' }, homedir: 'C:\\Users\\a',
        extensionPath: 'C:\\Users\\a\\.vscode\\extensions\\moag.agent-task-player-0.9.15', execPath: 'C:\\VSCode\\Code.exe',
      });
      assert.equal(p.binDir, 'C:\\Users\\a\\AppData\\Local\\moag\\bin');
      assert.equal(p.shimPath, 'C:\\Users\\a\\AppData\\Local\\moag\\bin\\moag.cmd');
      assert.equal(p.launcherDest, 'C:\\Users\\a\\AppData\\Local\\moag\\bin\\moag-launch.js');
      assert.equal(p.configPath, 'C:\\Users\\a\\AppData\\Local\\moag\\bin\\moag-shim.json');
      assert.deepEqual(p.extensionsDirs, ['C:\\Users\\a\\.vscode\\extensions']);
    });

    it('win32 without LOCALAPPDATA falls back under the home folder', () => {
      const p = planInstall({ platform: 'win32', env: {}, homedir: 'C:\\Users\\a', extensionPath: 'C:\\x\\ext', execPath: 'C:\\c.exe' });
      assert.equal(p.binDir, 'C:\\Users\\a\\AppData\\Local\\moag\\bin');
    });

    for (const platform of ['linux', 'darwin'] as const) {
      it(`${platform}: shim in ~/.local/bin, launcher and config in ~/.local/share/moag`, () => {
        const p = planInstall({ platform, env: { PATH: '/usr/bin' }, homedir: '/home/a', extensionPath: '/home/a/.vscode/extensions/moag.agent-task-player-0.9.15', execPath: '/usr/share/code/code' });
        assert.equal(p.binDir, '/home/a/.local/bin');
        assert.equal(p.shimPath, '/home/a/.local/bin/moag');
        assert.equal(p.launcherDest, '/home/a/.local/share/moag/moag-launch.js');
        assert.equal(p.configPath, '/home/a/.local/share/moag/moag-shim.json');
        assert.deepEqual(p.extensionsDirs, ['/home/a/.vscode/extensions']);
      });
    }
  });

  describe('shims', () => {
    it('the cmd shim uses setlocal, passes %* and exits with the launcher\'s code', () => {
      const s = renderCmdShim('C:\\Program Files\\Microsoft VS Code\\Code.exe');
      assert.match(s, /^@echo off/);
      assert.match(s, /setlocal/);
      assert.match(s, /%\*/);
      assert.match(s, /exit \/b %ERRORLEVEL%/);
      assert.match(s, /set ELECTRON_RUN_AS_NODE=1/);
      assert.match(s, /"C:\\Program Files\\Microsoft VS Code\\Code\.exe" "%~dp0moag-launch\.js" %\*/);
      assert.doesNotMatch(s, /\(\s*\r?\n/, 'no parenthesised blocks');
    });

    it('the cmd shim escapes % in the recorded path', () => {
      assert.match(renderCmdShim('C:\\100%\\Code.exe'), /C:\\100%%\\Code\.exe/);
    });

    it('the sh shim quotes paths with spaces and quotes', () => {
      const s = renderShShim("/home/a b/it's/moag-launch.js", '/opt/VS Code/code');
      assert.match(s, /^#!\/bin\/sh\n/);
      assert.ok(s.includes(`exec node '/home/a b/it'\\''s/moag-launch.js' "$@"`), s);
      assert.ok(s.includes(`ELECTRON_RUN_AS_NODE=1 exec '/opt/VS Code/code' '/home/a b/it'\\''s/moag-launch.js' "$@"`), s);
    });
  });

  describe('isOnPath', () => {
    it('win32: case-insensitive, slash- and trailing-separator-tolerant', () => {
      assert.equal(isOnPath('C:\\Users\\A\\AppData\\Local\\moag\\bin', 'C:\\Windows;c:/users/a/appdata/local/MOAG/bin\\;', 'win32'), true);
      assert.equal(isOnPath('C:\\x\\bin', 'C:\\Windows', 'win32'), false);
    });

    it('POSIX: case-sensitive', () => {
      assert.equal(isOnPath('/home/a/.local/bin', '/usr/bin:/home/a/.local/bin/', 'linux'), true);
      assert.equal(isOnPath('/home/a/.local/bin', '/usr/bin:/HOME/a/.local/bin', 'linux'), false);
    });
  });

  describe('Windows user PATH update', () => {
    it('never uses setx or SetEnvironmentVariable, and reads the folder only from $env:MOAG_BIN_DIR', () => {
      assert.doesNotMatch(WINDOWS_PATH_SCRIPT, /setx/i);
      assert.doesNotMatch(WINDOWS_PATH_SCRIPT, /SetEnvironmentVariable/i);
      assert.match(WINDOWS_PATH_SCRIPT, /\$dir = \$env:MOAG_BIN_DIR/);
      assert.match(WINDOWS_PATH_SCRIPT, /DoNotExpandEnvironmentNames/);
      assert.match(WINDOWS_PATH_SCRIPT, /ExpandString/);
    });

    it('passes the folder in the environment, never in the arguments', async () => {
      const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const ok = await addToWindowsUserPath('C:\\Users\\a\\AppData\\Local\\moag\\bin', async (cmd, args, o) => {
        calls.push({ cmd, args, env: o?.env });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false } as ExecFileAsyncResult;
      });
      assert.equal(ok, 'ok');
      assert.equal(calls[0].cmd, 'powershell.exe');
      assert.equal(calls[0].env?.MOAG_BIN_DIR, 'C:\\Users\\a\\AppData\\Local\\moag\\bin');
      assert.ok(!calls[0].args.join(' ').includes('moag\\bin'), 'the folder leaked into the command line');
    });

    it('win32: the PATH script parses with no PowerShell errors', function () {
      if (process.platform !== 'win32') { this.skip(); }
      this.timeout(30_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-ps-'));
      try {
        const file = path.join(dir, 'path.ps1');
        fs.writeFileSync(file, WINDOWS_PATH_SCRIPT);
        const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);$e.Count`;
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf-8' });
        if (r.error && /EPERM|ENOENT/.test(String(r.error))) { this.skip(); }
        assert.equal(r.stdout.trim(), '0', r.stderr);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('an unexpanded %LOCALAPPDATA%\\moag\\bin entry counts as already present', () => {
      assert.match(WINDOWS_PATH_SCRIPT, /\[Environment\]::ExpandEnvironmentVariables\(\$_\)\)\.TrimEnd\('\\'\) -ieq \$want/);
    });

    it('PATH written but the broadcast failed: exit 10 maps to restart-terminals, not failure', async () => {
      assert.match(WINDOWS_PATH_SCRIPT, /catch \{\s*exit 10\s*\}/);
      const r = await addToWindowsUserPath('C:\\b', async () => ({ exitCode: 10, stdout: '', stderr: 'Add-Type failed', timedOut: false }));
      assert.equal(r, 'restart-terminals');
    });

    it('a rejected or failed exec returns failed', async () => {
      assert.equal(await addToWindowsUserPath('C:\\b', async () => { throw new Error('ENOENT'); }), 'failed');
      assert.equal(await addToWindowsUserPath('C:\\b', async () => ({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false })), 'failed');
    });
  });

  describe('writeInstall', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('writes the launcher, the config and the shim, and reports whether the folder is on PATH', () => {
      const src = path.join(tmp, 'src-launch.js');
      fs.writeFileSync(src, '// launcher');
      const platform = process.platform;
      const plan = planInstall({
        platform, env: { LOCALAPPDATA: path.join(tmp, 'local'), PATH: '' }, homedir: tmp,
        extensionPath: path.join(tmp, 'exts', 'moag.agent-task-player-1.0.0'), execPath: process.execPath,
      });
      const r = writeInstall(plan, src);
      assert.equal(r.onPath, false);
      assert.equal(fs.readFileSync(plan.launcherDest, 'utf-8'), '// launcher');
      const cfg = JSON.parse(fs.readFileSync(plan.configPath, 'utf-8'));
      assert.deepEqual(cfg.extensionsDirs, [path.join(tmp, 'exts')]);
      assert.ok(fs.existsSync(plan.shimPath));
      if (platform !== 'win32') { assert.equal(fs.statSync(plan.shimPath).mode & 0o777, 0o755); }

      const again = writeInstall({ ...plan, pathEnv: plan.binDir }, src);
      assert.equal(again.onPath, true);
    });

    it('a missing launcher source throws', () => {
      const plan = planInstall({ platform: process.platform, env: { LOCALAPPDATA: tmp }, homedir: tmp, extensionPath: path.join(tmp, 'e'), execPath: process.execPath });
      assert.throws(() => writeInstall(plan, path.join(tmp, 'missing.js')));
    });

    it('win32: the generated moag.cmd passes arguments through and returns the launcher\'s exit code', function () {
      if (process.platform !== 'win32') { this.skip(); }
      this.timeout(30_000);
      const binDir = path.join(tmp, 'bin dir');
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, 'moag.cmd'), renderCmdShim(process.execPath));
      fs.writeFileSync(path.join(binDir, 'moag-launch.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(7);');
      const r = spawnSync('cmd.exe', ['/d', '/c', 'call', path.join(binDir, 'moag.cmd'), 'run', 'plan file.json'], { encoding: 'utf-8' });
      if (r.error && /EPERM/.test(String(r.error))) { this.skip(); }
      assert.equal(r.status, 7, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), ['run', 'plan file.json']);
    });
  });
});
