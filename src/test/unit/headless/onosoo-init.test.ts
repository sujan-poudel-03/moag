// ─── `moag init`: pair, list this repository, say what next ───

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmdInit, InitDeps, isPaired, parseInitArgs, slugId } from '../../../headless/onosoo-init';
import { loadApprovedProjects } from '../../../headless/onosoo-projects';

const KEY = 'moag_test_key_0123456789abcdef';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

interface Fixture {
  repo: string;
  config: string;
  stateDir: string;
  out: string[];
  err: string[];
  run: (argv?: string[], over?: Partial<InitDeps>) => Promise<number>;
}

/** A repo with a `.git` folder, an isolated config folder, and git/gh/pair faked. */
function fixture(opts: { name?: string; origin?: boolean; head?: string | null; gh?: boolean; paired?: boolean } = {}): Fixture {
  const root = tmp('moag-init-');
  const repo = path.join(root, opts.name ?? 'Shop App');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const config = path.join(root, 'config');
  fs.mkdirSync(config, { recursive: true });
  const stateDir = path.join(config, 'moag');
  if (opts.paired) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'onosoo.json'), JSON.stringify({ key: KEY, url: 'https://x.co' }));
  }
  const out: string[] = [];
  const err: string[] = [];
  const git = (args: string[]): string | null => {
    if (args[0] === 'rev-parse') { return repo; }
    if (args[0] === 'remote') { return opts.origin === false ? null : 'git@github.com:o/shop.git'; }
    if (args[0] === 'symbolic-ref') { return opts.head === undefined ? 'origin/main' : opts.head; }
    return null;
  };
  const run = (argv: string[] = [], over: Partial<InitDeps> = {}): Promise<number> => cmdInit(argv, {
    env: { APPDATA: config, XDG_CONFIG_HOME: config },
    platform: process.platform, homedir: () => root, cwd: repo,
    out: (s) => out.push(s), err: (s) => err.push(s),
    git, ghReady: () => opts.gh !== false,
    pair: async () => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'onosoo.json'), JSON.stringify({ key: KEY })); return 0; },
    ...over,
  });
  return { repo, config, stateDir, out, err, run };
}

const read = (f: Fixture): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(f.stateDir, 'projects.json'), 'utf-8'));

describe('moag init', () => {
  it('pairs, creates projects.json in local mode, adds the repository and says what to run next', async () => {
    const f = fixture();
    assert.equal(await f.run(), 0);
    assert.ok(isPaired(f.stateDir, {}));
    const doc = read(f);
    assert.equal(doc.mode, 'local');
    assert.equal(doc.remote_start, true);
    assert.equal(doc.daily_budget_usd, 10);
    const [p] = doc.projects as Array<Record<string, unknown>>;
    assert.equal(p.id, 'shop-app');
    assert.equal(p.name, 'Shop App');
    assert.equal(p.path, f.repo);
    assert.equal(p.delivery, 'draft-pr');
    assert.equal(p.pr_base, 'main');
    // The loader accepts what was written.
    const loaded = loadApprovedProjects(f.stateDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.mode, 'local');
    assert.equal(loaded.projects.length, 1);
    assert.match(f.out.join(''), /Next:/);
  });

  it('does not pair again when a key is saved', async () => {
    const f = fixture({ paired: true });
    let asked = false;
    assert.equal(await f.run([], { pair: async () => { asked = true; return 0; } }), 0);
    assert.equal(asked, false);
    assert.match(f.out.join(''), /Already paired/);
  });

  it('stops, changing nothing, when pairing fails', async () => {
    const f = fixture();
    assert.equal(await f.run([], { pair: async () => 1 }), 1);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'projects.json')), false);
    assert.match(f.err.join(''), /Not paired/);
  });

  it('chooses delivery from what the machine can do: branch without gh, off without an origin', async () => {
    const noGh = fixture({ gh: false });
    await noGh.run();
    assert.equal(((read(noGh).projects as Array<Record<string, unknown>>)[0]).delivery, 'branch');
    assert.match(noGh.out.join(''), /gh auth login/);
    const noOrigin = fixture({ origin: false });
    await noOrigin.run();
    assert.equal(((read(noOrigin).projects as Array<Record<string, unknown>>)[0]).delivery, 'off');
  });

  it('honours --delivery, --pr-base, --name, --id and --budget', async () => {
    const f = fixture();
    await f.run(['--delivery', 'branch', '--pr-base', 'dev', '--name', 'The shop', '--id', 'shop', '--budget', '25']);
    const doc = read(f);
    assert.equal(doc.daily_budget_usd, 25);
    assert.deepEqual((doc.projects as Array<Record<string, unknown>>)[0], {
      id: 'shop', name: 'The shop', path: f.repo, kinds: [], delivery: 'branch', pr_base: 'dev',
    });
  });

  it('adds to an existing file without changing its mode, budget or other projects', async () => {
    const f = fixture({ paired: true });
    const other = tmp('moag-other-');
    fs.mkdirSync(path.join(other, '.git'));
    const before = { version: 1, mode: 'isolated', remote_start: false, daily_budget_usd: 3, runner_user: 'moag-runner', projects: [{ id: 'old', name: 'Old', path: other, kinds: ['node'] }] };
    fs.writeFileSync(path.join(f.stateDir, 'projects.json'), JSON.stringify(before));
    assert.equal(await f.run(), 0);
    const doc = read(f);
    assert.equal(doc.mode, 'isolated');
    assert.equal(doc.remote_start, false);
    assert.equal(doc.daily_budget_usd, 3);
    assert.equal(doc.runner_user, 'moag-runner');
    assert.deepEqual((doc.projects as Array<{ id: string }>).map((p) => p.id), ['old', 'shop-app']);
    assert.match(f.out.join(''), /isolated mode/);
  });

  it('leaves an already-listed repository alone, and is safe to run twice', async () => {
    const f = fixture();
    await f.run();
    const first = fs.readFileSync(path.join(f.stateDir, 'projects.json'), 'utf-8');
    assert.equal(await f.run(), 0);
    assert.equal(fs.readFileSync(path.join(f.stateDir, 'projects.json'), 'utf-8'), first);
    assert.match(f.out.join(''), /already listed/);
  });

  it('gives a second repository with the same folder name its own id', async () => {
    const f = fixture({ paired: true });
    fs.writeFileSync(path.join(f.stateDir, 'projects.json'), JSON.stringify({ version: 1, mode: 'local', remote_start: true, projects: [{ id: 'shop-app', name: 'x', path: tmp('moag-x-'), kinds: [] }] }));
    // The other project's path has no .git, so only the new entry matters here.
    await f.run();
    const ids = (read(f).projects as Array<{ id: string }>).map((p) => p.id);
    assert.deepEqual(ids, ['shop-app', 'shop-app-2']);
  });

  it('refuses a file it cannot read, leaving it untouched', async () => {
    const f = fixture({ paired: true });
    fs.writeFileSync(path.join(f.stateDir, 'projects.json'), '{broken');
    assert.equal(await f.run(), 1);
    assert.equal(fs.readFileSync(path.join(f.stateDir, 'projects.json'), 'utf-8'), '{broken');
    assert.match(f.err.join(''), /could not be read/);
  });

  it('is not a git repository: exit 2 and nothing written', async () => {
    const f = fixture();
    assert.equal(await f.run([], { git: () => null }), 2);
    assert.match(f.err.join(''), /not inside a git repository/);
    assert.equal(fs.existsSync(f.stateDir), false);
  });

  it('refuses a project that would contain MOAG\'s own config folder', async () => {
    const f = fixture();
    const home = path.dirname(f.config);
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    assert.equal(await f.run([], { git: () => home, cwd: home }), 1);
    assert.match(f.err.join(''), /config folder/);
  });

  it('rejects wrong options with the usage and exit 2', async () => {
    for (const argv of [['--budget', '0'], ['--budget', 'x'], ['--delivery', 'merge'], ['--id', 'Bad Id'], ['--pr-base', '../x'], ['--nope'], ['a', 'b'], ['--url']]) {
      const f = fixture();
      assert.equal(await f.run(argv), 2, argv.join(' '));
      assert.match(f.err.join(''), /Usage: moag init/);
    }
  });

  it('slugId makes a valid id from any folder name', () => {
    assert.equal(slugId('Shop App'), 'shop-app');
    assert.equal(slugId('  --My_Repo.v2!!'), 'my_repo.v2');
    assert.equal(slugId('日本'), 'project');
    assert.deepEqual(parseInitArgs(['C:\\x', '--budget', '5']), { opts: { folder: 'C:\\x', budget: 5 } });
  });
});
