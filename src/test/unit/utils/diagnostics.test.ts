import { strict as assert } from 'assert';
import { buildDiagnosticsMarkdown, DiagnosticsFacts, renderSettingValue } from '../../../utils/diagnostics';
import { buildReportRedactor } from '../../../ui/report-redaction';

function facts(over: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    versions: { moag: '0.9.15', vscode: '1.95.0', os: 'win32 10.0', node: 'v20.0.0' },
    engines: [{ id: 'claude', available: true, version: '1.0.0' }, { id: 'codex', available: false }],
    settings: [],
    errors: [],
    relay: { status: 'none', urlOrigin: null },
    spool: { files: 0, bytes: 0 },
    daemonLogTail: null,
    generatedAt: '2026-10-26T00:00:00Z',
    ...over,
  };
}

describe('buildDiagnosticsMarkdown', () => {
  it('a secret-named setting renders [set] or [not set], never its value', () => {
    const md = buildDiagnosticsMarkdown(facts({
      settings: [
        { key: 'agentTaskPlayer.engines.anthropic.apiKey', value: 'sk-ant-xyz-abcdefghijklmnopqrstuvwxyz', isDefault: false },
        { key: 'agentTaskPlayer.someToken', value: '', isDefault: false },
      ],
    }));
    assert.ok(!md.includes('sk-ant-xyz'), md);
    assert.match(md, /anthropic\.apiKey \| \[set\]/);
    assert.match(md, /someToken \| \[not set\]/);
    assert.equal(renderSettingValue('x.password', 'hunter2'), '[set]');
  });

  it('a null daemon log renders "not found", and an empty error list "none"', () => {
    const md = buildDiagnosticsMarkdown(facts());
    assert.match(md, /## Daemon log \(Windows\)\n\nnot found/);
    assert.match(md, /## Recent errors\n\nnone/);
  });

  it('lists only changed settings and counts the rest', () => {
    const md = buildDiagnosticsMarkdown(facts({
      settings: [
        { key: 'agentTaskPlayer.defaultEngine', value: 'codex', isDefault: false },
        { key: 'agentTaskPlayer.autoplayDelay', value: 500, isDefault: true },
      ],
    }));
    assert.match(md, /agentTaskPlayer\.defaultEngine \| codex/);
    assert.ok(!md.includes('autoplayDelay'));
    assert.match(md, /1 other settings are at their defaults/);
  });

  it('a value with pipes and newlines stays one table cell', () => {
    assert.equal(renderSettingValue('a.b', 'x|y\nz'), 'x\\|y z');
  });

  it('end to end: a key in a setting, an error, a relay URL and the daemon log appears nowhere after redaction', () => {
    const key = 'onosoo-device-key-Q7Q7Q7Q7';
    const ant = 'sk-ant-api03-' + 'K'.repeat(40);
    const md = buildDiagnosticsMarkdown(facts({
      settings: [
        { key: 'agentTaskPlayer.promptRules', value: `always use ${key}`, isDefault: false },
        { key: 'agentTaskPlayer.engines.anthropic.apiKey', value: ant, isDefault: false },
      ],
      errors: [{ ts: '2026-10-26T00:00:00Z', category: 'github', message: `auth failed with ${key}`, stack: `Error\n    at f (${ant})` }],
      relay: { status: 'on', urlOrigin: `https://x.example.com/?k=${key}` },
      daemonLogTail: `posting with Bearer ${key}\nanthropic ${ant}`,
    }));
    const redact = buildReportRedactor({ cwd: null, home: null, env: {}, extraSecrets: [key, ant] });
    const out = redact(md);
    assert.ok(!out.includes(key), out);
    assert.ok(!out.includes(ant), out);
  });
});
