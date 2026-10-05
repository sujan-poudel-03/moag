import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as ts from 'typescript';
import { buildDeltaPlanPrompt, parseGeneratedPlan } from '../../../runner/prd-plan';
import { installFakeEngine, readFakeCalls, fakeOnlyPath, FAKE_VERSION_MARKER } from '../../../bench/fake-engine';
import { allowedIds } from '../../../bench/fake-claude';

function isSpawnEperm(err: unknown): boolean {
  return err instanceof Error && /spawn EPERM/i.test(err.message);
}

interface Ran { code: number | null; stdout: string; stderr: string }

/** Run `cmd args` with `input` on stdin. shell=true resolves `claude` the way runCli does. */
function run(cmd: string, args: string[], opts: { input?: string; cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

describe('bench fake claude', function () {
  this.timeout(30000);
  let tmp: string;
  let script: string;

  before(() => {
    // Transpile the standalone script so the test does not depend on a prior `npm run compile`.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moag-fake-')));
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'bench', 'fake-claude.ts'), 'utf-8');
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    script = path.join(tmp, 'fake-claude.js');
    fs.writeFileSync(script, js);
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const planPrompt = (): string => buildDeltaPlanPrompt({
    fullPrdText: '# Todo\n\n## Requirements\n- [R-1] add\n- [R-2] list\n',
    scope: { versionLabel: '1.1.0', added: [{ id: 'R-1', text: 'add', normalized: 'add', line: 4, tagged: true }], changed: [{ id: 'R-2', before: 'list', after: 'list in order' }] },
  });

  async function fake(args: string[], input: string, cwd = tmp, stateDir = tmp): Promise<Ran> {
    return run(process.execPath, [script, '--moag-fake-state', path.join(stateDir, 'fake-state.json'), ...args], { input, cwd });
  }

  it('reads the allowed ids from a real delta-plan prompt', () => {
    assert.deepEqual(allowedIds(planPrompt()), ['R-1', 'R-2']);
    assert.deepEqual(allowedIds('nothing here'), []);
  });

  it('plan mode: emits a plan parseGeneratedPlan accepts, citing R-1 and R-2, with the test command last', async function () {
    fs.writeFileSync(path.join(tmp, 'fake-state.json'), JSON.stringify({ fixtureDir: null, planCommand: 'npm test' }));
    let r: Ran;
    try { r = await fake(['-p'], planPrompt()); } catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.equal(r.code, 0, r.stderr);
    const parsed = parseGeneratedPlan(r.stdout);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const tasks = parsed.plan.playlists[0].tasks;
    assert.deepEqual(tasks.map((t) => t.requirementIds), [['R-1'], ['R-2'], ['R-1', 'R-2']]);
    assert.equal(tasks[2].type, 'command');
    assert.equal(tasks[2].command, 'npm test');
    assert.deepEqual(tasks[2].dependsOn, ['task-1', 'task-2']);
    assert.match(tasks[1].prompt, /list in order/, 'the prompt quotes the changed requirement line');
  });

  it('verify mode: a parsable passing verdict', async function () {
    let r: Ran;
    try { r = await fake(['-p'], 'Evidence...\nReply with JSON only: { "passed": boolean, "score": number (0-100), "gaps": string[], "suggestion": string }'); }
    catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.deepEqual(JSON.parse(r.stdout), { passed: true, score: 100, gaps: [], suggestion: '' });
  });

  it('task mode: copies the fixture into the cwd and logs the call', async function () {
    const stateDir = path.join(tmp, 'state-task');
    const fixture = path.join(tmp, 'fixture');
    const cwd = path.join(tmp, 'work');
    fs.mkdirSync(stateDir);
    fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(fixture, 'bin', 'todo.js'), 'console.log(1)\n');
    fs.writeFileSync(path.join(fixture, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(stateDir, 'fake-state.json'), JSON.stringify({ fixtureDir: fixture, planCommand: null }));
    let r: Ran;
    try { r = await fake(['-p'], 'Implement this requirement in the repository: [R-1] add', cwd, stateDir); }
    catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 files/);
    assert.equal(fs.readFileSync(path.join(cwd, 'bin', 'todo.js'), 'utf-8'), 'console.log(1)\n');
    const calls = readFakeCalls({ callsPath: path.join(stateDir, 'calls.jsonl') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'task');
  });

  it('wraps the reply as a Claude JSON result when --output-format json is passed', async function () {
    let r: Ran;
    try { r = await fake(['-p', '--output-format', 'json', '--max-budget-usd', '1.00'], 'Reply with JSON only: { "passed": boolean }'); }
    catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    const o = JSON.parse(r.stdout.trim());
    assert.equal(o.type, 'result');
    assert.equal(o.is_error, false);
    assert.equal(o.total_cost_usd, 0);
    assert.equal(JSON.parse(o.result).passed, true);
  });

  it('--version carries the marker', async function () {
    let r: Ran;
    try { r = await fake(['--version'], ''); } catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.ok(r.stdout.includes(FAKE_VERSION_MARKER), r.stdout);
  });

  it('the installed shim is what a shell resolves for `claude` once its bin dir leads PATH', async function () {
    const binDir = path.join(tmp, 'bin');
    const engine = installFakeEngine(binDir, script);
    assert.ok(fs.readFileSync(path.join(binDir, 'claude.cmd'), 'utf-8').includes('%*'));
    assert.ok(fs.readFileSync(path.join(binDir, 'claude'), 'utf-8').startsWith('#!/bin/sh'));
    if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(binDir, 'claude')).mode & 0o111, 0o111); }
    engine.setVersion('/fixture', 'npm test');
    assert.deepEqual(JSON.parse(fs.readFileSync(engine.statePath, 'utf-8')), { fixtureDir: '/fixture', planCommand: 'npm test' });

    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: fakeOnlyPath(process.env[pathKey] ?? '', binDir) };
    let r: Ran;
    try { r = await run('claude --version', [], { cwd: tmp, env, shell: true }); } catch (err) { if (isSpawnEperm(err)) { this.skip(); return; } throw err; }
    assert.ok(r.stdout.includes(FAKE_VERSION_MARKER), `resolved a real claude: ${r.stdout} ${r.stderr}`);
  });

  it('fakeOnlyPath puts the bin dir first and drops directories that hold another claude', () => {
    const other = path.join(tmp, 'other-bin');
    const plain = path.join(tmp, 'plain-bin');
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(other, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    const binDir = path.join(tmp, 'fake-bin');
    const out = fakeOnlyPath([plain, other, binDir].join(path.delimiter), binDir).split(path.delimiter);
    assert.deepEqual(out, [binDir, plain]);
  });
});
