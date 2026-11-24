// ─── `moag service`: the Windows scheduled task for the daemon ───

import { strict as assert } from 'assert';
import {
  cmdService, ExecResult, runnerScript, ServiceDeps, servicePaths, taskXml, TASK_NAME,
} from '../../../headless/service-windows';

const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', USERNAME: 'me', USERDOMAIN: 'PC', SystemRoot: 'C:\\Windows' };

function run(verb: string | undefined, over: Partial<ServiceDeps> = {}, results: Record<string, ExecResult> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const written: Record<string, string | Buffer> = {};
  const code = cmdService(verb, {
    platform: 'win32', env, homedir: () => 'C:\\Users\\me', node: 'C:\\Program Files\\nodejs\\node.exe',
    cli: 'D:\\Projects\\moag\\out\\headless\\cli.js',
    exec: (_file, args) => { calls.push(args); return results[args[0]] ?? { status: 0, stdout: '', stderr: '' }; },
    mkdir: () => undefined,
    write: (f, data) => { written[f] = data; },
    out: (s) => out.push(s), err: (s) => err.push(s),
    ...over,
  });
  return { code, out: out.join(''), err: err.join(''), calls, written };
}

describe('moag service', () => {
  it('keeps its files under LocalAppData, outside MOAG\'s config folder and the home folder', () => {
    const p = servicePaths(env);
    assert.equal(p.workDir, 'C:\\Users\\me\\AppData\\Local\\moag\\daemon-home'.replaceAll('\\', require('path').sep));
    assert.ok(!p.workDir.toLowerCase().includes('roaming'));
  });

  it('the task starts at logon, hidden, unlimited, restarted on failure, never elevated', () => {
    const x = taskXml({ user: 'PC\\me', paths: servicePaths(env) });
    assert.match(x, /<LogonTrigger>/);
    assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(x, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
    assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(x, /-WindowStyle Hidden/);
    assert.ok(!/RunLevel>HighestAvailable/.test(x));
  });

  it('escapes a user name and paths in the task definition', () => {
    const x = taskXml({ user: 'A&B\\o<m>', paths: servicePaths(env) });
    assert.match(x, /A&amp;B\\o&lt;m&gt;/);
  });

  it('the runner script logs, rotates, runs the daemon and passes its exit code on', () => {
    const s = runnerScript({ node: "C:\\it's\\node.exe", cli: 'D:\\moag\\cli.js', paths: servicePaths(env) });
    assert.match(s, /it''s/); // a quote in a path is doubled, not left to end the string
    assert.match(s, /daemon 2>&1/);
    assert.match(s, /exit \$LASTEXITCODE/);
    assert.match(s, /Set-Location/);
    assert.match(s, /5MB/);
  });

  it('install writes the script and a UTF-16 task, registers it and starts it', () => {
    const r = run('install');
    assert.equal(r.code, 0);
    const xml = Object.entries(r.written).find(([f]) => f.endsWith('daemon-task.xml'))?.[1] as Buffer;
    assert.deepEqual([xml[0], xml[1]], [0xff, 0xfe]);
    assert.ok(xml.toString('utf16le').includes('MOAG daemon'));
    assert.deepEqual(r.calls.map((c) => c[0]), ['/Create', '/Run']);
    assert.ok(r.calls[0].includes(TASK_NAME));
    assert.match(r.out, /starts when you sign in/);
    assert.match(r.out, /Close any `moag daemon` window/);
  });

  it('install says so when Windows refuses the task, and does not try to start it', () => {
    const r = run('install', {}, { '/Create': { status: 1, stdout: '', stderr: 'Access is denied.' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /Access is denied/);
    assert.deepEqual(r.calls.map((c) => c[0]), ['/Create']);
  });

  it('install still succeeds when only starting it now fails', () => {
    const r = run('install', {}, { '/Run': { status: 1, stdout: '', stderr: 'busy' } });
    assert.equal(r.code, 0);
    assert.match(r.out, /next sign-in/);
  });

  it('refuses to install into MOAG\'s config folder', () => {
    const r = run('install', { env: { ...env, LOCALAPPDATA: env.APPDATA } });
    assert.equal(r.code, 1);
    assert.match(r.err, /inside MOAG's config folder/);
    assert.deepEqual(r.calls, []);
  });

  it('uninstall removes the task, and is quiet when there is none', () => {
    assert.match(run('uninstall').out, /Removed/);
    const none = run('uninstall', {}, { '/Delete': { status: 1, stdout: '', stderr: 'not found' } });
    assert.equal(none.code, 0);
    assert.match(none.out, /not installed/);
  });

  it('status reports the task state, or that it is not installed', () => {
    const listed = run('status', {}, { '/Query': { status: 0, stderr: '', stdout: 'TaskName: \\MOAG Daemon\r\nStatus: Running\r\nLast Run Time: 11/24/2026 9:00:00 AM\r\nLast Result: 0\r\n' } });
    assert.equal(listed.code, 0);
    assert.match(listed.out, /Status:\s+Running/);
    assert.match(listed.out, /Last result: 0/);
    const missing = run('status', {}, { '/Query': { status: 1, stdout: '', stderr: 'ERROR' } });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Not installed/);
  });

  it('off Windows it says what to use instead, and a bad verb prints the usage', () => {
    const linux = run('install', { platform: 'linux' });
    assert.equal(linux.code, 2);
    assert.match(linux.err, /systemd/);
    assert.deepEqual(linux.calls, []);
    const bad = run('restart');
    assert.equal(bad.code, 2);
    assert.match(bad.err, /Usage: moag service/);
  });
});
