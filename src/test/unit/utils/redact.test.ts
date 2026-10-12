// ─── Secret redactor ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRedactor, isSecretCandidate, readEnvFileSecrets, REDACTED } from '../../../utils/redact';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moag-redact-'));
}

describe('redact — env file secrets (AC12)', () => {
  it('keeps only secret-looking values from .env and .env.local', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abcd1234efgh\nPORT=12345678\n# COMMENT=shouldnotappear1\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'DEBUG=true\nSHORT=abc\n');
    const values = readEnvFileSecrets(dir);
    assert.deepEqual(values, ['abcd1234efgh']);

    const r = createRedactor(values);
    const out = r.redact('TOKEN=abcd1234efgh PORT=12345678 DEBUG=true SHORT=abc');
    assert.equal(out.text, `TOKEN=${REDACTED} PORT=12345678 DEBUG=true SHORT=abc`);
    assert.equal(out.count, 1);
  });

  it('strips matching quotes and a leading export', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.env'), 'export A="quoted-secret-1"\nB=\'single-quoted-2\'\n');
    assert.deepEqual(readEnvFileSecrets(dir), ['quoted-secret-1', 'single-quoted-2']);
  });

  it('returns [] for a missing directory and never throws', () => {
    assert.deepEqual(readEnvFileSecrets(path.join(os.tmpdir(), 'moag-does-not-exist-' + Date.now())), []);
  });

  it('isSecretCandidate rejects short, numeric and boolean-like values', () => {
    assert.equal(isSecretCandidate('abc'), false);
    assert.equal(isSecretCandidate('12345678'), false);
    assert.equal(isSecretCandidate('FALSE'), false);
    assert.equal(isSecretCandidate('Null'), false);
    assert.equal(isSecretCandidate('abcd1234efgh'), true);
  });
});

describe('redact — exact values', () => {
  it('replaces the ANTHROPIC_API_KEY value and the device key', () => {
    const apiKey = 'some-anthropic-key-value';
    const deviceKey = 'onosoo_live_' + 'A'.repeat(43);
    const r = createRedactor([apiKey, deviceKey]);
    const out = r.redact(`key=${apiKey}\nAuthorization: Bearer ${deviceKey}`);
    assert.ok(!out.text.includes(apiKey));
    assert.ok(!out.text.includes(deviceKey));
    assert.ok(out.count >= 2);
  });

  it('counts occurrences, not distinct values', () => {
    const r = createRedactor(['xyzzy-secret-1']);
    const out = r.redact('a xyzzy-secret-1 b xyzzy-secret-1 c');
    assert.equal(out.count, 2);
    assert.equal(out.text, `a ${REDACTED} b ${REDACTED} c`);
  });

  it('ignores exact values shorter than 8 characters', () => {
    const r = createRedactor(['short', '']);
    const out = r.redact('a short text');
    assert.equal(out.text, 'a short text');
    assert.equal(out.count, 0);
  });

  it('replaces the longest value first when values overlap', () => {
    const r = createRedactor(['abcdefgh', 'abcdefgh-longer']);
    const out = r.redact('x abcdefgh-longer y');
    assert.equal(out.text, `x ${REDACTED} y`);
    assert.equal(out.count, 1);
  });
});

describe('redact — patterns (AC13)', () => {
  const r = createRedactor([]);
  const cases: Array<[string, string, string]> = [
    ['sk- key', 'sk-' + 'a'.repeat(30), 'sk-'],
    ['sk-ant- key', 'sk-ant-api03-' + 'B'.repeat(40), 'sk-ant'],
    ['ghp_ token', 'ghp_' + 'c'.repeat(36), 'ghp_'],
    ['AKIA id', 'AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'eyJ'],
  ];
  for (const [name, secret, marker] of cases) {
    it(`redacts a ${name}`, () => {
      const out = r.redact(`before ${secret} after`);
      assert.equal(out.text, `before ${REDACTED} after`);
      assert.ok(!out.text.includes(marker));
      assert.equal(out.count, 1);
    });
  }

  it('redacts a PEM private key block inside +-prefixed diff lines', () => {
    const diff = [
      '+const x = 1;',
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEowIBAAKCAQEAsecretbody',
      '+-----END RSA PRIVATE KEY-----',
      '+const y = 2;',
    ].join('\n');
    const out = r.redact(diff);
    assert.ok(!out.text.includes('MIIEowIBAAKCAQEAsecretbody'));
    assert.ok(out.text.includes('+const y = 2;'));
    assert.equal(out.count, 1);
  });

  it('redacts a PEM BEGIN without END to the end of the text', () => {
    const out = r.redact('ok\n-----BEGIN PRIVATE KEY-----\nMIIsecretrest\nmore');
    assert.equal(out.text, `ok\n${REDACTED}`);
    assert.equal(out.count, 1);
  });

  it('redacts only the value of password= assignments', () => {
    const out = r.redact('password=hunter22 and API_KEY: "zzzzzz"');
    assert.equal(out.text, `password=${REDACTED} and API_KEY: "${REDACTED}"`);
    assert.equal(out.count, 2);
  });

  const assignments: Array<[string, string, string]> = [
    ['DB_PASSWORD=hunter2hunter', 'hunter2hunter', `DB_PASSWORD=${REDACTED}`],
    ['GITHUB_TOKEN=abcd1234efgh5678', 'abcd1234efgh5678', `GITHUB_TOKEN=${REDACTED}`],
    ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI', `export AWS_SECRET_ACCESS_KEY=${REDACTED}`],
    ['{"apiKey": "abcd1234efgh5678"}', 'abcd1234efgh5678', `{"apiKey": "${REDACTED}"}`],
    ["{'token': 'abcd1234efgh5678'}", 'abcd1234efgh5678', `{'token': '${REDACTED}'}`],
    ['  password: s3cr3tpass', 's3cr3tpass', `  password: ${REDACTED}`],
    ["client_secret => 'xyz12345678'", 'xyz12345678', `client_secret => '${REDACTED}'`],
    ['PRIVATE_KEY_PASSPHRASE=longphrase1', 'longphrase1', `PRIVATE_KEY_PASSPHRASE=${REDACTED}`],
    ['x-api-key: abcd1234efgh5678', 'abcd1234efgh5678', `x-api-key: ${REDACTED}`],
    ['api-key=abcd1234efgh5678', 'abcd1234efgh5678', `api-key=${REDACTED}`],
    ['{"password":"p@ss;word1"}', 'p@ss;word1', `{"password":"${REDACTED}"}`],
    ['PASSWORD = "hunter 2 with spaces"', 'hunter 2 with spaces', `PASSWORD = "${REDACTED}"`],
    ["token: 'a,b&c d;e'", 'a,b&c d;e', `token: '${REDACTED}'`],
  ];
  for (const [input, secret, expected] of assignments) {
    it(`redacts the value of ${input.trim().slice(0, 40)}`, () => {
      const out = r.redact(input);
      assert.equal(out.text, expected);
      assert.ok(!out.text.includes(secret));
      assert.equal(out.count, 1);
    });
  }

  it('leaves ordinary code alone', () => {
    for (const code of [
      'const tokenCount = 5', 'passwordInput.focus()', 'if (secretsLoaded) { run(); }', 'let mytoken;', 'function getToken() {}',
      'maxTokens: 4096', 'const tokens = 5000', 'temperature_token_ratio = 0.75',
      'password: string;', '  apiKey: string,', 'function f(token: unknown) {}', 'secret: boolean', 'pwd: undefined;',
    ]) {
      const out = r.redact(code);
      assert.equal(out.text, code, code);
      assert.equal(out.count, 0, code);
    }
  });

  it('a long identifier run stays linear', () => {
    const text = ('a'.repeat(5000) + ' ').repeat(200) + 'x_token=' + '_'.repeat(100_000);
    const start = Date.now();
    r.redact(text);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  });

  it('redacts only the password of URL credentials', () => {
    const out = r.redact('postgres://user:pa55word@host/db');
    assert.equal(out.text, `postgres://user:${REDACTED}@host/db`);
    assert.equal(out.count, 1);
  });

  it('counts each match', () => {
    const k = 'ghp_' + 'd'.repeat(36);
    assert.equal(r.redact(`${k} ${k} ${k}`).count, 3);
  });

  it('redacts 1 MB of text in under a second', () => {
    const chunk = 'lorem ipsum password=abcdefgh sk-' + 'x'.repeat(25) + ' https://u:p@h/ eyJ\n';
    const text = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
    const start = Date.now();
    const out = r.redact(text);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
    assert.ok(out.count > 0);
  });
});
