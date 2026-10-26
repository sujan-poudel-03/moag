import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkPairing, inspectPairing, PairError, removePairing, writePairing,
} from '../../../headless/onosoo-pair';
import { DEFAULT_ONOSOO_URL } from '../../../headless/onosoo-config';
import type { ExecFileAsyncResult } from '../../../utils/exec-file';

const KEY = 'onosoo-device-key-AAAA1111';
const KEY2 = 'onosoo-device-key-BBBB2222';

/** Every file under `dir`, recursively. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...allFiles(p)); } else { out.push(p); }
  }
  return out;
}

describe('ONOSOO pairing: writePairing / removePairing', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let execCalls: Array<{ cmd: string; args: string[] }>;
  const okExec = async (cmd: string, args: string[]): Promise<ExecFileAsyncResult> => {
    execCalls.push({ cmd, args }); return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const stateDir = (): string => path.join(home, 'cfg', 'moag');
  const file = (): string => path.join(stateDir(), 'onosoo.json');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'onosoo-pair-'));
    env = { APPDATA: path.join(home, 'cfg'), XDG_CONFIG_HOME: path.join(home, 'cfg'), USERNAME: 'alice', USERDOMAIN: 'BOX' };
    execCalls = [];
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  /** Put one unacked run (two events) in the spool. */
  function seedSpool(): void {
    const dir = path.join(stateDir(), 'onosoo-spool', 'ws1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-1.jsonl'), '{"meta":{}}\n{"seq":1}\n{"seq":2}\n');
  }

  it('writes key and the default URL, keeping an existing device_id', async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ device_id: 'dev-1' }));
    const r = await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    assert.equal(r.file, file());
    const saved = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    assert.deepEqual(saved, { device_id: 'dev-1', key: KEY, url: DEFAULT_ONOSOO_URL });
    assert.equal(r.aclApplied, 'n/a');
    assert.equal(r.keyChanged, false);
    assert.deepEqual(r.saved, { key: KEY, endpoint: `${DEFAULT_ONOSOO_URL}/functions/v1/builds/events`, deviceId: 'dev-1' });
  });

  it('a first pairing gets a device id, returned for the check', async () => {
    const r = await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    const saved = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    assert.match(saved.device_id, /^[0-9a-f-]{36}$/);
    assert.equal(r.saved.deviceId, saved.device_id);
  });

  it('the file is mode 600 on POSIX', async function () {
    if (process.platform === 'win32') { this.skip(); }
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
  });

  it('an invalid key throws a PairError that does not echo it, and writes nothing', async () => {
    const bad = 'has a space in it 1234';
    await assert.rejects(writePairing({ key: bad, env, platform: 'linux', homedir: () => home }), (err: Error) => {
      assert.ok(err instanceof PairError);
      assert.ok(!err.message.includes(bad));
      return true;
    });
    assert.equal(fs.existsSync(file()), false);
  });

  it('a non-https URL is rejected', async () => {
    await assert.rejects(
      writePairing({ key: KEY, url: 'http://onosoo.example.com', env, platform: 'linux', homedir: () => home }),
      PairError,
    );
    await assert.rejects(
      writePairing({ key: KEY, url: 'https://x.example.com/?k=1', env, platform: 'linux', homedir: () => home }),
      PairError,
    );
  });

  it('an unchanged key keeps the spool', async () => {
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    seedSpool();
    assert.deepEqual(inspectPairing({ key: KEY, env, platform: 'linux', homedir: () => home }), { keyChanged: false, unsentEvents: 0 });
    const r = await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    assert.equal(r.spoolDiscarded, 0);
    assert.ok(fs.existsSync(path.join(stateDir(), 'onosoo-spool', 'ws1', 'run-1.jsonl')));
  });

  it('a changed key discards the spool, and inspectPairing counts the unsent events first', async () => {
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    seedSpool();
    assert.deepEqual(inspectPairing({ key: KEY2, env, platform: 'linux', homedir: () => home }), { keyChanged: true, unsentEvents: 2 });
    const r = await writePairing({ key: KEY2, env, platform: 'linux', homedir: () => home });
    assert.equal(r.keyChanged, true);
    assert.equal(r.spoolDiscarded, 1);
    assert.equal(fs.existsSync(path.join(stateDir(), 'onosoo-spool')), false);
  });

  it('a changed key never wipes a run a relay still holds (this process, or a live one)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spoolMod = require('../../../headless/onosoo-spool');
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    const dir = path.join(stateDir(), 'onosoo-spool', 'ws1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mine-live.jsonl'), '{"meta":{}}\n{"seq":1}\n');
    fs.writeFileSync(path.join(dir, 'other-live.jsonl'), `{"meta":{"pid":424242}}\n{"seq":1}\n`);
    fs.writeFileSync(path.join(dir, 'other-dead.jsonl'), `{"meta":{"pid":535353}}\n{"seq":1}\n`);
    fs.writeFileSync(path.join(dir, 'old.jsonl'), '{"meta":{}}\n{"seq":1}\n');
    fs.writeFileSync(path.join(dir, 'old.ack'), '{"acked":0}');
    spoolMod.registerLiveRelayRun('mine-live');
    try {
      const r = await writePairing({
        key: KEY2, env, platform: 'linux', homedir: () => home,
        liveness: { isPidAlive: (pid: number) => pid === 424242 },
      });
      assert.equal(r.spoolDiscarded, 2);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['mine-live.jsonl', 'other-live.jsonl']);
    } finally {
      spoolMod.releaseLiveRelayRun('mine-live');
    }
  });

  it('on win32 locks the folder with icacls (no shell, the folder and the user as arguments)', async () => {
    const r = await writePairing({ key: KEY, env, platform: 'win32', homedir: () => home, exec: okExec });
    assert.equal(r.aclApplied, true);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cmd, 'icacls');
    assert.deepEqual(execCalls[0].args, [stateDir(), '/inheritance:r', '/grant:r', 'BOX\\alice:(OI)(CI)F']);
    assert.ok(!execCalls[0].args.join(' ').includes(KEY));
  });

  it('on win32 an icacls failure still writes the file', async () => {
    const r = await writePairing({
      key: KEY, env, platform: 'win32', homedir: () => home,
      exec: async () => { throw new Error('icacls missing'); },
    });
    assert.equal(r.aclApplied, false);
    assert.equal(JSON.parse(fs.readFileSync(file(), 'utf-8')).key, KEY);
  });

  it('removePairing drops key and url, keeps device_id, and discards the spool', async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ device_id: 'dev-1' }));
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    seedSpool();
    const r = removePairing({ env, platform: 'linux', homedir: () => home });
    assert.ok(r);
    assert.equal(r.spoolDiscarded, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf-8')), { device_id: 'dev-1' });
  });

  it('removePairing with nothing saved returns null', () => {
    assert.equal(removePairing({ env, platform: 'linux', homedir: () => home }), null);
  });

  it('no file other than onosoo.json ever contains the key', async () => {
    await writePairing({ key: KEY, env, platform: 'linux', homedir: () => home });
    seedSpool();
    await writePairing({ key: KEY2, env, platform: 'win32', homedir: () => home, exec: okExec });
    for (const f of allFiles(home)) {
      if (f === file()) { continue; }
      const text = fs.readFileSync(f, 'utf-8');
      assert.ok(!text.includes(KEY) && !text.includes(KEY2), `${f} holds a key`);
    }
  });
});

describe('ONOSOO pairing: checkPairing', () => {
  const cfg = { key: KEY, endpoint: 'https://x.example.com/functions/v1/builds/events', deviceId: 'dev-1' };
  const reply = (status: number) => async () => ({ status, body: '{}' });

  it('maps 200 to accepted, 401 and 403 to refused, 500 to unverified', async () => {
    assert.equal(await checkPairing(cfg, reply(200)), 'accepted');
    assert.equal(await checkPairing(cfg, reply(401)), 'refused');
    assert.equal(await checkPairing(cfg, reply(403)), 'refused');
    assert.deepEqual(await checkPairing(cfg, reply(500)), { unverified: 'HTTP 500' });
  });

  it('maps a network rejection to unverified, without the key in the reason', async () => {
    const r = await checkPairing(cfg, async () => { throw new Error(`ECONNREFUSED while sending ${KEY}`); });
    assert.ok(typeof r === 'object' && 'unverified' in r);
    assert.ok(!r.unverified.includes(KEY), r.unverified);
  });

  it('sends the empty envelope with a Bearer key, to the endpoint', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    await checkPairing(cfg, async (req) => { seen = req; return { status: 200, body: '' }; });
    assert.ok(seen);
    const s = seen as { url: string; headers: Record<string, string>; body: string };
    assert.equal(s.url, cfg.endpoint);
    assert.equal(s.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(s.body);
    assert.equal(body.protocol, 1);
    assert.equal(body.device_id, 'dev-1');
    assert.deepEqual(body.events, []);
    assert.equal(typeof body.moag_version, 'string');
  });
});
