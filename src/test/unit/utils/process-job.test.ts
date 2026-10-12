import { strict as assert } from 'assert';
import { bindProcessTreeToLifetime, helperFailureReason, helperStderrText, jobHelperArgs, JOB_KILL_ON_CLOSE_SCRIPT } from '../../../utils/process-job';

// ─── Windows job-object binder (no real PowerShell: exec is injected) ───

function recorder(result: string | (() => string)) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (file: string, args: string[]): string => {
    calls.push({ file, args });
    return typeof result === 'function' ? result() : result;
  };
  return { calls, exec };
}

function decode(args: string[]): string {
  const i = args.indexOf('-EncodedCommand');
  assert.ok(i >= 0, 'passes -EncodedCommand');
  return Buffer.from(args[i + 1], 'base64').toString('utf16le');
}

describe('process-job', () => {
  describe('bindProcessTreeToLifetime', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      it(`does nothing on ${platform}`, () => {
        const r = recorder('ok');
        const res = bindProcessTreeToLifetime(4242, { platform, exec: r.exec });
        assert.deepEqual(res, { ok: false, reason: `not supported on ${platform}` });
        assert.equal(r.calls.length, 0);
      });
    }

    for (const pid of [0, -1, 1.5, NaN]) {
      it(`rejects pid ${pid} without running the helper`, () => {
        const r = recorder('ok');
        const res = bindProcessTreeToLifetime(pid, { platform: 'win32', exec: r.exec });
        assert.equal(res.ok, false);
        assert.equal(r.calls.length, 0);
      });
    }

    it('runs the absolute PowerShell path with an encoded script for the pid', () => {
      const r = recorder('ok\r\n');
      const res = bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec, env: { SystemRoot: 'D:\\Win' } });
      assert.deepEqual(res, { ok: true });
      assert.equal(r.calls.length, 1);
      assert.match(r.calls[0].file, /^D:\\Win[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
      assert.deepEqual(r.calls[0].args.slice(0, 2), ['-NoProfile', '-NonInteractive']);
      const script = decode(r.calls[0].args);
      assert.ok(script.includes('Make(4242)'));
      assert.ok(script.includes('DuplicateHandle'));
      assert.ok(script.includes('AssignProcessToJobObject'));
      // KILL_ON_JOB_CLOSE (0x2000) | BREAKAWAY_OK (0x800)
      assert.ok(script.includes('LimitFlags = 0x2800'));
    });

    it('falls back to SYSTEMROOT, then C:\\Windows', () => {
      const r = recorder('ok');
      bindProcessTreeToLifetime(7, { platform: 'win32', exec: r.exec, env: { SYSTEMROOT: 'E:\\W' } });
      bindProcessTreeToLifetime(7, { platform: 'win32', exec: r.exec, env: {} });
      assert.ok(r.calls[0].file.startsWith('E:\\W'));
      assert.ok(r.calls[1].file.startsWith('C:\\Windows'));
    });

    it('reports the failing step the helper printed', () => {
      const r = recorder('assign 5');
      assert.deepEqual(bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec }), { ok: false, reason: 'assign 5' });
    });

    it('caps a long helper output at 200 characters', () => {
      const r = recorder('x'.repeat(500));
      const res = bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec });
      assert.equal(res.ok, false);
      assert.equal((res as { reason: string }).reason.length, 200);
    });

    it('treats empty output as a failure', () => {
      const r = recorder('');
      assert.equal(bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec }).ok, false);
    });

    it('never throws when the helper cannot run (ENOENT, timeout)', () => {
      for (const code of ['ENOENT', 'ETIMEDOUT']) {
        const r = recorder(() => { throw Object.assign(new Error(`spawnSync powershell.exe ${code}`), { code }); });
        assert.deepEqual(bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec }), { ok: false, reason: `job helper failed (${code})` });
      }
    });

    it('never puts err.message (the base64 command line) into the reason', () => {
      const base64 = jobHelperArgs(4242)[3];
      const r = recorder(() => {
        throw Object.assign(new Error(`Command failed: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -EncodedCommand ${base64}\nboom`), {
          status: 1, signal: null, stderr: 'Add-Type : Cannot add type. Definition of new types is not supported in this language mode.\r\n',
        });
      });
      const res = bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec });
      assert.equal(res.ok, false);
      const reason = (res as { reason: string }).reason;
      assert.ok(base64.length > 5000, 'the command line really is large');
      assert.ok(!reason.includes(base64.slice(0, 40)), 'no base64 in the reason');
      assert.ok(!reason.includes('Command failed'), 'not err.message');
      assert.ok(reason.length <= 250, `short reason, got ${reason.length}`);
      assert.equal(reason, 'job helper failed (exit 1): Add-Type : Cannot add type. Definition of new types is not supported in this language mode.');
    });

    it('caps stderr at 200 characters and reports a signal', () => {
      const r = recorder(() => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: 'e'.repeat(1000) }); });
      const reason = (bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec }) as { reason: string }).reason;
      assert.equal(reason, `job helper failed (ETIMEDOUT, signal SIGTERM): ${'e'.repeat(200)}`);
    });

    it('survives a non-Error throw', () => {
      const r = recorder(() => { throw 'nope'; });
      assert.deepEqual(bindProcessTreeToLifetime(4242, { platform: 'win32', exec: r.exec }), { ok: false, reason: 'job helper failed: nope' });
    });
  });

  describe('helperStderrText / helperFailureReason', () => {
    const CLIXML = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>'
      + '<S S="Error">Add-Type : Cannot add type. Definition of new types is not supported in this language _x000D__x000A_</S>'
      + '<S S="Error">mode. &gt;&gt;&gt; &amp; done_x000D__x000A_</S></Objs>';

    it('decodes PowerShell CLIXML error records and drops progress', () => {
      assert.equal(helperStderrText(CLIXML), 'Add-Type : Cannot add type. Definition of new types is not supported in this language mode. >>> & done');
      assert.equal(helperStderrText(Buffer.from(CLIXML)), helperStderrText(CLIXML));
    });

    it('passes plain text through, collapsed; non-strings give empty text', () => {
      assert.equal(helperStderrText('  a\r\n  b  '), 'a b');
      assert.equal(helperStderrText(undefined), '');
      assert.equal(helperStderrText(42), '');
    });

    it('a failure with no detail still says how it failed', () => {
      assert.equal(helperFailureReason({ status: 3 }), 'job helper failed (exit 3)');
      assert.equal(helperFailureReason(new Error('only a message')), 'job helper failed');
      assert.equal(helperFailureReason(null), 'job helper failed: null');
    });
  });

  describe('jobHelperArgs / JOB_KILL_ON_CLOSE_SCRIPT', () => {
    it('encodes exactly the script for the pid', () => {
      assert.equal(decode(jobHelperArgs(99)), JOB_KILL_ON_CLOSE_SCRIPT(99));
    });
  });
});
