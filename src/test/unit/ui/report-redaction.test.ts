import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReportRedactor, REDACTION_FAILED_TEXT, scrubEscapedPrefix } from '../../../ui/report-redaction';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();

describe('buildReportRedactor', () => {
  let tmp: string;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-redaction-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('removes a value from the workspace .env file', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_PASSWORD=hunter2-very-secret\n');
    const r = buildReportRedactor({ cwd: tmp, home: null, env: {}, extraSecrets: [] });
    const out = r('connect failed with hunter2-very-secret');
    assert.ok(!out.includes('hunter2-very-secret'), out);
  });

  it('removes Anthropic and GitHub token shapes', () => {
    const r = buildReportRedactor({ cwd: null, home: null, env: {}, extraSecrets: [] });
    const ant = 'sk-ant-api03-' + 'a'.repeat(40);
    const ghp = 'ghp_' + 'B'.repeat(36);
    const out = r(`key ${ant} and token ${ghp}`);
    assert.ok(!out.includes(ant), out);
    assert.ok(!out.includes(ghp), out);
  });

  it('removes extra secrets and named env tokens as exact values', () => {
    const r = buildReportRedactor({
      cwd: null, home: null,
      env: { GH_TOKEN: 'plain-gh-token-123', MOAG_ONOSOO_KEY: 'onosoo-device-key-xyz' },
      extraSecrets: ['my-anthropic-secret-value'],
    });
    const out = r('a my-anthropic-secret-value b plain-gh-token-123 c onosoo-device-key-xyz');
    assert.ok(!out.includes('my-anthropic-secret-value'), out);
    assert.ok(!out.includes('plain-gh-token-123'), out);
    assert.ok(!out.includes('onosoo-device-key-xyz'), out);
  });

  it('shortens the home folder to ~ and the workspace to .', () => {
    const r = buildReportRedactor({ cwd: 'C:\\Users\\alice\\work\\app', home: 'C:\\Users\\alice', env: {}, extraSecrets: [] });
    const out = r('failed at C:\\Users\\alice\\proj\\x.ts and C:\\Users\\alice\\work\\app\\src\\a.ts');
    assert.ok(out.includes('~\\proj\\x.ts'), out);
    assert.ok(out.includes('.\\src\\a.ts'), out);
    assert.ok(!out.includes('alice'), out);
  });

  it('reads no .env when there is no workspace', () => {
    // A .env in the process cwd must not be read for cwd: null.
    const calls: string[] = [];
    const { buildReportRedactor: build } = proxyquire('../../../ui/report-redaction', {
      '../headless/task-reporting': {
        reportingSecretValues: (cwd: string) => { calls.push(cwd); return []; },
      },
    });
    build({ cwd: null, home: null, env: {}, extraSecrets: ['x'] })('text');
    assert.deepEqual(calls, []);
  });

  it('returns the placeholder, never the input, when the redactor throws', () => {
    const { buildReportRedactor: build } = proxyquire('../../../ui/report-redaction', {
      '../utils/redact': {
        createRedactor: () => ({ redact: () => { throw new Error('boom'); } }),
      },
    });
    const out = build({ cwd: null, home: null, env: {}, extraSecrets: [] })('secret sk-ant-xyz');
    assert.equal(out, REDACTION_FAILED_TEXT);
  });

  it('returns the placeholder when building the redactor throws', () => {
    const { buildReportRedactor: build } = proxyquire('../../../ui/report-redaction', {
      '../utils/redact': { createRedactor: () => { throw new Error('boom'); } },
    });
    assert.equal(build({ cwd: null, home: null, env: {}, extraSecrets: [] })('anything'), REDACTION_FAILED_TEXT);
  });
});

describe('scrubEscapedPrefix', () => {
  const BS = '\\';
  const doubled = (p: string): string => p.split(BS).join(BS + BS);

  it('replaces the JSON-escaped form of a Windows prefix, case-insensitively, at a boundary only', () => {
    const text = `{"a":"${doubled('C:\\Users\\alice\\x.ts')}","b":"${doubled('c:\\USERS\\ALICE')}","c":"${doubled('C:\\Users\\alicea\\y')}"}`;
    const out = scrubEscapedPrefix(text, 'C:\\Users\\alice', '~');
    assert.equal(out, `{"a":"~${BS}${BS}x.ts","b":"~","c":"${doubled('C:\\Users\\alicea\\y')}"}`);
  });

  it('leaves POSIX prefixes and drive roots alone', () => {
    assert.equal(scrubEscapedPrefix('/home/alice/x', '/home/alice', '~'), '/home/alice/x');
    assert.equal(scrubEscapedPrefix('C:\\\\x', 'C:\\', '~'), 'C:\\\\x');
  });

  it('the report redactor removes a JSON-escaped home and workspace path', () => {
    const r = buildReportRedactor({ cwd: 'C:\\Users\\alice\\work\\app', home: 'C:\\Users\\alice', env: {}, extraSecrets: [] });
    const out = r(`error {"file":"${doubled('C:\\Users\\alice\\work\\app\\src\\a.ts')}","cache":"${doubled('c:\\users\\ALICE\\.cache')}"}`);
    assert.ok(!/alice/i.test(out), out);
  });
});
