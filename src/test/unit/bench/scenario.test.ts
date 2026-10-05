import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseScenario, BenchScenarioError, dryRunProblem, isInsideOrSame } from '../../../bench/scenario';

describe('bench scenario', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moag-scn-'));
    fs.mkdirSync(path.join(dir, 'template'));
    fs.mkdirSync(path.join(dir, 'prd'));
    fs.mkdirSync(path.join(dir, 'fx', 'v1'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fx', 'v2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prd', 'v1.md'), '# P\n\n## Requirements\n- [R-1] a\n');
    fs.writeFileSync(path.join(dir, 'prd', 'v2.md'), '# P\n\n## Requirements\n- [R-1] a b\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const base = (): Record<string, unknown> => ({
    name: 'demo',
    description: 'd',
    repo: { kind: 'template', templateDir: 'template' },
    setupCommands: [],
    stack: 'node-ts',
    engine: 'claude',
    budgetUsd: 10,
    perCallCapUsd: 1,
    gateCommands: ['npm test'],
    versions: [
      { id: 'v1', prdFile: 'prd/v1.md', intendedBump: 'initial', dryRunFixture: 'fx/v1' },
      { id: 'v2', prdFile: 'prd/v2.md', intendedBump: 'patch', dryRunFixture: 'fx/v2' },
    ],
    dryRun: { planCommand: 'npm test' },
  });
  const write = (doc: unknown): string => {
    const f = path.join(dir, 'scenario.json');
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  const rejects = (mutate: (d: Record<string, unknown>) => void, fieldPath: string): void => {
    const d = base();
    mutate(d);
    assert.throws(() => parseScenario(write(d)), (err: unknown) => {
      assert.ok(err instanceof BenchScenarioError, String(err));
      assert.equal(err.fieldPath, fieldPath, err.message);
      return true;
    });
  };
  const versions = (d: Record<string, unknown>) => d.versions as Array<Record<string, unknown>>;

  it('parses a valid scenario, resolving paths against its directory and applying defaults', () => {
    const s = parseScenario(write(base()));
    assert.equal(s.name, 'demo');
    assert.equal(s.dir, dir);
    assert.deepEqual(s.repo, { kind: 'template', templateDir: path.join(dir, 'template') });
    assert.equal(s.versions[1].prdFile, path.join(dir, 'prd', 'v2.md'));
    assert.equal(s.versions[0].intendedBump, 'initial');
    assert.equal(s.minVersionUsd, 1);
    assert.equal(s.reserveFactor, 1.5);
    assert.equal(s.versionTimeoutMin, 60);
    assert.equal(s.gateTimeoutMs, 600_000);
    assert.deepEqual(s.passEnv, []);
    assert.deepEqual(s.allowedCommands, []);
    assert.deepEqual(s.environmentProbes, []);
    assert.equal(dryRunProblem(s), null);
  });

  it('allowedCommands and environmentProbes are exact single-line strings: kept verbatim, bad entries rejected by path', () => {
    const s = parseScenario(write({ ...base(), allowedCommands: ['npm run build', 'npm install && npm test'], environmentProbes: ['npm test'] }));
    assert.deepEqual(s.allowedCommands, ['npm run build', 'npm install && npm test']);
    assert.deepEqual(s.environmentProbes, ['npm test']);
    for (const key of ['allowedCommands', 'environmentProbes']) {
      rejects((d) => { d[key] = 'npm test'; }, key);
      rejects((d) => { d[key] = ['npm test', 7]; }, `${key}[1]`);
      rejects((d) => { d[key] = ['  ']; }, `${key}[0]`);
      rejects((d) => { d[key] = ['npm test\ngit push']; }, `${key}[0]`);
      rejects((d) => { d[key] = ['x'.repeat(501)]; }, `${key}[0]`);
      rejects((d) => { d[key] = ['npm test', ' npm test ']; }, `${key}[1]`);
    }
  });

  it('rejects each invalid field with its path', () => {
    rejects((d) => { delete d.name; }, 'name');
    rejects((d) => { d.repo = { kind: 'svn' }; }, 'repo.kind');
    rejects((d) => { d.stack = 'cobol'; }, 'stack');
    rejects((d) => { d.engine = 'gpt'; }, 'engine');
    rejects((d) => { d.engine = 'custom'; }, 'engine');
    rejects((d) => { d.budgetUsd = 0; }, 'budgetUsd');
    rejects((d) => { d.budgetUsd = 101; }, 'budgetUsd');
    rejects((d) => { d.perCallCapUsd = 11; }, 'perCallCapUsd');
    rejects((d) => { d.perCallCapUsd = -1; }, 'perCallCapUsd');
    rejects((d) => { d.reserveFactor = 0.5; }, 'reserveFactor');
    rejects((d) => { d.gateCommands = []; }, 'gateCommands');
    rejects((d) => { d.gateCommands = ['npm test', '']; }, 'gateCommands[1]');
    rejects((d) => { d.versions = []; }, 'versions');
    rejects((d) => { versions(d)[1].prdFile = 'prd/missing.md'; }, 'versions[1].prdFile');
    rejects((d) => { versions(d)[1].id = 'v1'; }, 'versions[1].id');
    rejects((d) => { versions(d)[1].intendedBump = 'huge'; }, 'versions[1].intendedBump');
    rejects((d) => { versions(d)[0].intendedBump = 'minor'; }, 'versions[0].intendedBump');
    rejects((d) => { d.dryRun = { planCommand: '' }; }, 'dryRun.planCommand');
  });

  it('only the first version may be initial', () => {
    rejects((d) => { versions(d)[1].intendedBump = 'initial'; }, 'versions[1].intendedBump');
  });

  it('refuses ../ escapes from the scenario directory', () => {
    rejects((d) => { versions(d)[0].prdFile = '../outside.md'; }, 'versions[0].prdFile');
    rejects((d) => { d.repo = { kind: 'template', templateDir: '..' }; }, 'repo.templateDir');
    rejects((d) => { versions(d)[1].dryRunFixture = '../../fx'; }, 'versions[1].dryRunFixture');
  });

  it('refuses CI and MOAG_* in passEnv, and malformed names', () => {
    rejects((d) => { d.passEnv = ['CI']; }, 'passEnv[0]');
    rejects((d) => { d.passEnv = ['NODE_OPTIONS', 'MOAG_MASTER_KEY']; }, 'passEnv[1]');
    rejects((d) => { d.passEnv = ['A B']; }, 'passEnv[0]');
    assert.deepEqual(parseScenario(write({ ...base(), passEnv: ['NODE_OPTIONS'] })).passEnv, ['NODE_OPTIONS']);
  });

  it('a clone source must be an existing directory and the ref a plain name', () => {
    rejects((d) => { d.repo = { kind: 'clone', path: 'nope', ref: 'main' }; }, 'repo.path');
    rejects((d) => { d.repo = { kind: 'clone', path: 'template', ref: '--upload-pack=x' }; }, 'repo.ref');
    const s = parseScenario(write({ ...base(), repo: { kind: 'clone', path: 'template', ref: 'main' } }));
    assert.deepEqual(s.repo, { kind: 'clone', path: path.join(dir, 'template'), ref: 'main' });
  });

  it('an unreadable or non-object file is a scenario error', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{not json');
    assert.throws(() => parseScenario(f), BenchScenarioError);
    fs.writeFileSync(f, '[]');
    assert.throws(() => parseScenario(f), /\(root\)/);
  });

  it('dryRunProblem names what a dry-run lacks', () => {
    const d = base();
    delete versions(d)[1].dryRunFixture;
    assert.match(dryRunProblem(parseScenario(write(d))) ?? '', /v2/);
    const d2 = base();
    delete d2.dryRun;
    assert.match(dryRunProblem(parseScenario(write(d2))) ?? '', /dryRun/);
  });

  it('isInsideOrSame handles equality, nesting and siblings', () => {
    assert.equal(isInsideOrSame('/a/b', '/a/b'), true);
    assert.equal(isInsideOrSame('/a/b', '/a/b/c'), true);
    assert.equal(isInsideOrSame('/a/b', '/a/bc'), false);
    assert.equal(isInsideOrSame('/a/b', '/a'), false);
  });
});
