import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildKG, lookupSymbols, rebuildKGForFile } from '../../../context/knowledge-graph';

describe('buildKG', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes an exported function', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), 'export function renderWidget() {}');
    const kg = buildKG(tmpDir);
    assert.ok(kg.symbols.has('renderwidget'));
    const nodes = kg.symbols.get('renderwidget')!;
    assert.equal(nodes[0].kind, 'function');
    assert.ok(nodes[0].filePath.replace(/\\/g, '/').endsWith('foo.ts'));
    assert.equal(nodes[0].startLine, 1);
  });

  it('indexes exported class and interface', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'model.ts'),
      'export class TaskRunner {}\nexport interface PlanOptions {}');
    const kg = buildKG(tmpDir);
    assert.ok(kg.symbols.has('taskrunner'));
    assert.ok(kg.symbols.has('planoptions'));
    assert.equal(kg.symbols.get('planoptions')![0].kind, 'interface');
  });

  it('indexes exported const', () => {
    fs.writeFileSync(path.join(tmpDir, 'consts.ts'), 'export const MAX_RETRIES = 3;');
    const kg = buildKG(tmpDir);
    assert.ok(kg.symbols.has('max_retries'));
    assert.equal(kg.symbols.get('max_retries')![0].kind, 'const');
  });

  it('skips node_modules directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'),
      'export function secretFn() {}');
    const kg = buildKG(tmpDir);
    assert.ok(!kg.symbols.has('secretfn'));
  });

  it('skips out directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'out', 'compiled.ts'), 'export function builtFn() {}');
    const kg = buildKG(tmpDir);
    assert.ok(!kg.symbols.has('builtfn'));
  });

  it('skips files larger than 200KB', () => {
    const padding = 'x'.repeat(210_000);
    fs.writeFileSync(path.join(tmpDir, 'big.ts'),
      `export function bigFn() { /* ${padding} */ }`);
    const kg = buildKG(tmpDir);
    assert.ok(!kg.symbols.has('bigfn'));
  });

  it('populates fileCount correctly', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function a() {}');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function b() {}');
    const kg = buildKG(tmpDir);
    assert.equal(kg.fileCount, 2);
  });

  it('sets builtAt to a recent timestamp', () => {
    const before = Date.now();
    const kg = buildKG(tmpDir);
    assert.ok(kg.builtAt >= before);
    assert.ok(kg.builtAt <= Date.now() + 1000);
  });
});

describe('lookupSymbols', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lookup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a SemanticSpan with confidence 0.7', () => {
    fs.writeFileSync(path.join(tmpDir, 'comp.ts'), 'export function buildContext() {}');
    const kg = buildKG(tmpDir);
    const spans = lookupSymbols(kg, ['buildContext']);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].confidence, 0.7);
    assert.equal(spans[0].label, 'buildContext');
  });

  it('lookup is case-insensitive', () => {
    fs.writeFileSync(path.join(tmpDir, 'x.ts'), 'export class MyClass {}');
    const kg = buildKG(tmpDir);
    const spans = lookupSymbols(kg, ['MYCLASS']);
    assert.ok(spans.length > 0);
    assert.equal(spans[0].label, 'MyClass');
  });

  it('deduplicates spans with identical filePath+startLine', () => {
    fs.writeFileSync(path.join(tmpDir, 'dup.ts'), 'export function fooFn() {}');
    const kg = buildKG(tmpDir);
    const spans = lookupSymbols(kg, ['fooFn', 'foofn', 'FOOFN']);
    assert.equal(spans.length, 1);
  });

  it('returns empty array for unknown symbol', () => {
    const kg = buildKG(tmpDir);
    const spans = lookupSymbols(kg, ['unknownSymbolXyz']);
    assert.deepEqual(spans, []);
  });
});

describe('rebuildKGForFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-rebuild-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes old entries and re-indexes when file content changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'upd.ts'), 'export function oldFn() {}');
    const kg = buildKG(tmpDir);
    assert.ok(kg.symbols.has('oldfn'));

    fs.writeFileSync(path.join(tmpDir, 'upd.ts'), 'export function newFn() {}');
    rebuildKGForFile(kg, tmpDir, 'upd.ts');

    assert.ok(!kg.symbols.has('oldfn'), 'old symbol should be removed');
    assert.ok(kg.symbols.has('newfn'), 'new symbol should be indexed');
  });

  it('does not affect symbols from other files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function alphaFn() {}');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function betaFn() {}');
    const kg = buildKG(tmpDir);

    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function gammaFn() {}');
    rebuildKGForFile(kg, tmpDir, 'b.ts');

    assert.ok(kg.symbols.has('alphafn'), 'unrelated file symbols unchanged');
    assert.ok(!kg.symbols.has('betafn'), 'old symbol removed');
    assert.ok(kg.symbols.has('gammafn'), 'new symbol added');
  });
});
