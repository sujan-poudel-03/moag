// ─── ONOSOO relay configuration ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { endpointFor, EVENTS_PATH, resolveOnosooConfig } from '../../../headless/onosoo-config';

const KEY = 'onosoo_live_' + 'A'.repeat(43);

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A fresh user config dir and a separate workspace, plus an env pointing at the former. */
function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const configDir = tmp('moag-onosoo-cfg-');
  const cwd = tmp('moag-onosoo-ws-');
  const env: NodeJS.ProcessEnv = { APPDATA: configDir, XDG_CONFIG_HOME: configDir, ...extraEnv };
  const errors: string[] = [];
  const resolve = (over: NodeJS.ProcessEnv = {}) =>
    resolveOnosooConfig({ env: { ...env, ...over }, cwd, homedir: () => configDir, stderr: (s) => errors.push(s) });
  const file = path.join(configDir, 'moag', 'onosoo.json');
  const writeFile = (o: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(o));
  };
  return { configDir, cwd, env, errors, resolve, file, writeFile };
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p)); } else { out.push(p); }
  }
  return out;
}

describe('ONOSOO config', () => {
  it('no key → null, silently, and creates no file', () => {
    const f = fixture({ MOAG_ONOSOO_URL: 'https://xyz.supabase.co' });
    assert.equal(f.resolve(), null);
    assert.deepEqual(f.errors, []);
    assert.equal(fs.existsSync(path.join(f.configDir, 'moag')), false);
  });

  it('env key and URL win over the file', () => {
    const f = fixture();
    f.writeFile({ key: 'file-key-value-123', url: 'https://file.example.com', device_id: 'dev-1' });
    const cfg = f.resolve({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://xyz.supabase.co' });
    assert.ok(cfg);
    assert.equal(cfg.key, KEY);
    assert.equal(cfg.endpoint, `https://xyz.supabase.co${EVENTS_PATH}`);
    assert.equal(cfg.deviceId, 'dev-1');
    assert.equal(cfg.stateDir, path.join(f.configDir, 'moag'));
  });

  it('reads key and URL from the file alone', () => {
    const f = fixture();
    f.writeFile({ key: KEY, url: 'https://xyz.supabase.co/' });
    const cfg = f.resolve();
    assert.ok(cfg);
    assert.equal(cfg.key, KEY);
    assert.equal(cfg.endpoint, 'https://xyz.supabase.co/functions/v1/builds/events');
  });

  it('a key without a URL → null with one stderr line', () => {
    const f = fixture({ MOAG_ONOSOO_KEY: KEY });
    assert.equal(f.resolve(), null);
    assert.equal(f.errors.length, 1);
    assert.ok(!f.errors[0].includes(KEY));
  });

  it('an invalid URL → null with one stderr line', () => {
    const f = fixture({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'http://example.com' });
    assert.equal(f.resolve(), null);
    assert.equal(f.errors.length, 1);
  });

  it('accepts the ONOSOO key format', () => {
    const f = fixture({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://x.co' });
    assert.ok(f.resolve());
  });

  it('a malformed file is treated as empty', () => {
    const f = fixture({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://x.co' });
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, '{not json');
    const cfg = f.resolve();
    assert.ok(cfg);
    assert.match(cfg.deviceId, /^[0-9a-f-]{36}$/);
  });

  it('generates the device id once and keeps it across calls, preserving other keys', () => {
    const f = fixture({ MOAG_ONOSOO_URL: 'https://x.co' });
    f.writeFile({ key: KEY, note: 'kept' });
    const a = f.resolve();
    const b = f.resolve();
    assert.ok(a && b);
    assert.equal(a.deviceId, b.deviceId);
    const onDisk = JSON.parse(fs.readFileSync(f.file, 'utf-8'));
    assert.equal(onDisk.device_id, a.deviceId);
    assert.equal(onDisk.note, 'kept');
    assert.equal(onDisk.key, KEY);
  });

  it('a config dir inside the workspace → null with a stderr note, nothing written there', () => {
    const cwd = tmp('moag-onosoo-ws-');
    const errors: string[] = [];
    const cfg = resolveOnosooConfig({
      env: { APPDATA: cwd, XDG_CONFIG_HOME: cwd, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://x.co' },
      cwd, homedir: () => cwd, stderr: (s) => errors.push(s),
    });
    assert.equal(cfg, null);
    assert.equal(errors.length, 1);
    assert.deepEqual(walk(cwd), []);
  });

  it('no file under the workspace contains the key or the device id', () => {
    const f = fixture({ MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://x.co' });
    fs.writeFileSync(path.join(f.cwd, 'README.md'), 'hello');
    const cfg = f.resolve();
    assert.ok(cfg);
    for (const p of walk(f.cwd)) {
      const text = fs.readFileSync(p, 'utf-8');
      assert.ok(!text.includes(KEY) && !text.includes(cfg.deviceId), p);
    }
  });

  it('uses %APPDATA% on win32 and XDG_CONFIG_HOME elsewhere', () => {
    const a = tmp('moag-onosoo-a-');
    const x = tmp('moag-onosoo-x-');
    const cwd = tmp('moag-onosoo-ws-');
    const env = { APPDATA: a, XDG_CONFIG_HOME: x, MOAG_ONOSOO_KEY: KEY, MOAG_ONOSOO_URL: 'https://x.co' };
    assert.equal(resolveOnosooConfig({ env, cwd, platform: 'win32', stderr: () => undefined })?.stateDir, path.join(a, 'moag'));
    assert.equal(resolveOnosooConfig({ env, cwd, platform: 'linux', stderr: () => undefined })?.stateDir, path.join(x, 'moag'));
  });
});

describe('ONOSOO config — endpointFor', () => {
  it('appends the events path to an https base, dropping a trailing slash', () => {
    assert.equal(endpointFor('https://xyz.supabase.co'), 'https://xyz.supabase.co/functions/v1/builds/events');
    assert.equal(endpointFor('https://xyz.supabase.co/'), 'https://xyz.supabase.co/functions/v1/builds/events');
  });

  it('allows http only for loopback hosts', () => {
    assert.equal(endpointFor('http://127.0.0.1:54321'), 'http://127.0.0.1:54321/functions/v1/builds/events');
    assert.equal(endpointFor('http://localhost:54321/'), 'http://localhost:54321/functions/v1/builds/events');
    assert.equal(endpointFor('http://[::1]:54321'), 'http://[::1]:54321/functions/v1/builds/events');
    assert.equal(endpointFor('http://example.com'), null);
  });

  it('rejects a query, a fragment, credentials and non-URLs', () => {
    assert.equal(endpointFor('https://x.co/?a=1'), null);
    assert.equal(endpointFor('https://x.co/#f'), null);
    assert.equal(endpointFor('https://u:p@x.co'), null);
    assert.equal(endpointFor('ftp://x.co'), null);
    assert.equal(endpointFor('not a url'), null);
  });
});
