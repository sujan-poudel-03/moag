import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyquire = require('proxyquire').noCallThru();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscodeMock = require('../mocks/vscode');

// `moag-paths.ts` imports the real 'vscode' module, which does not exist
// outside a VS Code host — proxyquire it even for the pure function.
const { upgradeGitignoreForUsageLog, ensureMoagDir } = proxyquire('../../../workspace/moag-paths', {
  vscode: vscodeMock,
});

describe('upgradeGitignoreForUsageLog', () => {
  it('appends both lines for a fresh workspace with no .gitignore', () => {
    const result = upgradeGitignoreForUsageLog('');
    assert.equal(result, '.moag/*\n!.moag/usage-log.jsonl\n');
  });

  it('migrates an existing bare .moag/ line in place, preserving its position', () => {
    const before = 'node_modules/\n.moag/\ndist/\n';
    const result = upgradeGitignoreForUsageLog(before);
    assert.equal(result, 'node_modules/\n.moag/*\n!.moag/usage-log.jsonl\ndist/\n');
  });

  it('is idempotent — running twice never duplicates a line', () => {
    const before = 'node_modules/\n.moag/\ndist/\n';
    const once = upgradeGitignoreForUsageLog(before);
    const twice = upgradeGitignoreForUsageLog(once);
    assert.equal(twice, once);
  });

  it('does not corrupt an unrelated custom pattern', () => {
    const before = '# custom\n*.log\nbuild/\ncoverage/\n';
    const result = upgradeGitignoreForUsageLog(before);
    assert.equal(result, '# custom\n*.log\nbuild/\ncoverage/\n.moag/*\n!.moag/usage-log.jsonl\n');
  });

  it('appends only the negation when .moag/* is present without it', () => {
    const before = 'node_modules/\n.moag/*\n';
    const result = upgradeGitignoreForUsageLog(before);
    assert.equal(result, 'node_modules/\n.moag/*\n!.moag/usage-log.jsonl\n');
  });
});

describe('ensureMoagDir', () => {
  let tmpDir: string;
  const realWorkspaceFolders = vscodeMock.workspace.workspaceFolders;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-paths-test-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  });

  afterEach(() => {
    vscodeMock.workspace.workspaceFolders = realWorkspaceFolders;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .moag/, and writes a correct .gitignore and .gitattributes on disk', () => {
    const dir = ensureMoagDir();
    assert.equal(dir, path.join(tmpDir, '.moag'));
    assert.ok(fs.existsSync(dir));

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.moag/*'));
    assert.ok(gitignore.includes('!.moag/usage-log.jsonl'));

    const gitattributes = fs.readFileSync(path.join(tmpDir, '.gitattributes'), 'utf-8');
    assert.ok(gitattributes.includes('.moag/usage-log.jsonl merge=union'));
  });
});
