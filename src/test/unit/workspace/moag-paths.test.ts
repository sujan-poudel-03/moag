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
const {
  upgradeGitignoreForUsageLog, ensureMoagDir, setMoagDirCreatedListener, gitignoreLinesFor, applyGitignoreChoice,
} = proxyquire('../../../workspace/moag-paths', {
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

  afterEach(() => { setMoagDirCreatedListener(null); });

  it('creates .moag/ and never creates or changes .gitignore or .gitattributes', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
    const dir = ensureMoagDir();
    assert.equal(dir, path.join(tmpDir, '.moag'));
    assert.ok(fs.existsSync(dir));
    assert.equal(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8'), 'node_modules/\n');
    assert.equal(fs.existsSync(path.join(tmpDir, '.gitattributes')), false);
  });

  it('fires the dir-created listener once, on creation only', () => {
    const seen: string[] = [];
    setMoagDirCreatedListener((d: string) => seen.push(d));
    ensureMoagDir();
    ensureMoagDir();
    assert.deepEqual(seen, [path.join(tmpDir, '.moag')]);
  });

  it('does not fire when .moag/ already exists, and a throwing listener does not break it', () => {
    fs.mkdirSync(path.join(tmpDir, '.moag'));
    let fired = 0;
    setMoagDirCreatedListener(() => { fired++; });
    ensureMoagDir();
    assert.equal(fired, 0);
    fs.rmSync(path.join(tmpDir, '.moag'), { recursive: true });
    setMoagDirCreatedListener(() => { throw new Error('boom'); });
    assert.equal(ensureMoagDir(), path.join(tmpDir, '.moag'));
  });
});

describe('gitignore choice', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-gitignore-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('gitignoreLinesFor: share the plan, or ignore everything', () => {
    assert.deepEqual(gitignoreLinesFor('share-plan'), ['.moag/*', '!.moag/plan.json', '!.moag/.agent-plan.json']);
    assert.deepEqual(gitignoreLinesFor('ignore-all'), ['.moag/']);
  });

  it('share-plan appends after existing lines, leaves them alone, and is idempotent', () => {
    const file = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(file, 'node_modules/\ndist');
    assert.equal(applyGitignoreChoice(tmpDir, 'share-plan'), true);
    const once = fs.readFileSync(file, 'utf-8');
    assert.equal(once, 'node_modules/\ndist\n.moag/*\n!.moag/plan.json\n!.moag/.agent-plan.json\n');
    assert.equal(applyGitignoreChoice(tmpDir, 'share-plan'), false);
    assert.equal(fs.readFileSync(file, 'utf-8'), once);
  });

  it('creates .gitignore when there is none, and keeps CRLF files CRLF', () => {
    assert.equal(applyGitignoreChoice(tmpDir, 'ignore-all'), true);
    assert.equal(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8'), '.moag/\n');
    const crlf = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-gitignore-crlf-'));
    try {
      fs.writeFileSync(path.join(crlf, '.gitignore'), 'a\r\n');
      applyGitignoreChoice(crlf, 'ignore-all');
      assert.equal(fs.readFileSync(path.join(crlf, '.gitignore'), 'utf-8'), 'a\r\n.moag/\r\n');
    } finally { fs.rmSync(crlf, { recursive: true, force: true }); }
  });
});
