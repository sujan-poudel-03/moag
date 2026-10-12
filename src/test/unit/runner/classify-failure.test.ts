import { strict as assert } from 'assert';
import type * as RunnerModule from '../../../runner/runner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// The adapter registry pulls in the VS Code-only Copilot adapter; nothing here runs an engine.
const { classifyFailure, missingProgramName } = proxyquire('../../../runner/runner', {
  'vscode': vscodeMock,
  '../adapters/index': { getEngine: () => { throw new Error('no engine in this test'); } },
}) as typeof RunnerModule;

// ─── classifyFailure: a missing project tool is not a missing engine ───

const ENGINE_REASON = 'CLI not found — ensure the engine is installed and on PATH.';
const WIN_TSC = "'tsc' is not recognized as an internal or external command,\r\noperable program or batch file.";

describe('classifyFailure', () => {
  it('a command step whose tool is missing (Windows) names the tool as a project tool', () => {
    const fc = classifyFailure(WIN_TSC, '', { taskType: 'command' });
    assert.equal(fc.category, 'cli-missing');
    assert.equal(fc.agentCanFix, false);
    assert.match(fc.reason, /^'tsc' was not found\./);
    assert.match(fc.reason, /project tool/);
    assert.doesNotMatch(fc.reason, /ensure the engine is installed/);
    assert.ok(fc.errorLines.length > 0);
  });

  it('a check step on bash names the tool', () => {
    const fc = classifyFailure('bash: line 1: jest: command not found', '', { taskType: 'check' });
    assert.equal(fc.category, 'cli-missing');
    assert.match(fc.reason, /^'jest' was not found/);
  });

  it('dash output alone is not newly classified: detection is unchanged, only the reason text is', () => {
    // `sh: 1: X: not found` never matched the cli-missing detection; widening it would
    // change the category (auto-fix, fallback, evidence), which this fix does not do.
    assert.equal(classifyFailure('sh: 1: jest: not found', '', { taskType: 'check' }).category,
      classifyFailure('sh: 1: jest: not found', '').category);
  });

  it('a service step on bash names the tool', () => {
    const fc = classifyFailure('bash: vite: command not found', '', { taskType: 'service' });
    assert.match(fc.reason, /^'vite' was not found/);
  });

  it('an agent step keeps the engine reason (no regression)', () => {
    const fc = classifyFailure(WIN_TSC, '', { taskType: 'agent' });
    assert.equal(fc.category, 'cli-missing');
    assert.equal(fc.reason, ENGINE_REASON);
  });

  it('a review step is an engine step too', () => {
    assert.equal(classifyFailure('spawn claude ENOENT', '', { taskType: 'review' }).reason, ENGINE_REASON);
  });

  it('a visual-test step is an engine step too', () => {
    assert.equal(classifyFailure('spawn claude ENOENT', '', { taskType: 'visual-test' }).reason, ENGINE_REASON);
  });

  it('without context the reason is the engine one (the default)', () => {
    const fc = classifyFailure(WIN_TSC, '');
    assert.equal(fc.category, 'cli-missing');
    assert.equal(fc.reason, ENGINE_REASON);
  });

  it('a command step with no extractable name says "A program this step runs"', () => {
    const fc = classifyFailure('Error: ENOENT: no such file or directory', '', { taskType: 'command' });
    assert.equal(fc.category, 'cli-missing');
    assert.match(fc.reason, /^A program this step runs was not found\./);
  });

  it('auth text that also says "not found" is still auth (order preserved)', () => {
    const fc = classifyFailure('Not authenticated: credentials file not found\nbash: x: command not found', '', { taskType: 'command' });
    assert.equal(fc.category, 'auth');
  });

  it('a failure that is not a missing program is unaffected by the context', () => {
    const a = classifyFailure('src/a.ts(1,1): error TS2322: Type mismatch', '', { taskType: 'command' });
    const b = classifyFailure('src/a.ts(1,1): error TS2322: Type mismatch', '');
    assert.deepEqual(a, b);
  });
});

describe('missingProgramName', () => {
  it('reads each shell form', () => {
    assert.equal(missingProgramName(WIN_TSC), 'tsc');
    assert.equal(missingProgramName('bash: line 1: eslint: command not found'), 'eslint');
    assert.equal(missingProgramName('zsh: command not found: foo'), 'foo', 'not the shell name');
    assert.equal(missingProgramName('sh: 1: jest: not found'), 'jest');
    assert.equal(missingProgramName('Error: spawn pnpm ENOENT'), 'pnpm');
  });

  it('prefers the Windows form when several appear', () => {
    assert.equal(missingProgramName(`${WIN_TSC}\nspawn other ENOENT`), 'tsc');
  });

  it('is null when no program is named', () => {
    assert.equal(missingProgramName('ENOENT: no such file or directory'), null);
    assert.equal(missingProgramName(''), null);
  });
});
