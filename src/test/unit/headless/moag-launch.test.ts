import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { cliPathIn, compareVersions, LaunchFs, pickCli } from '../../../headless/moag-launch';

/** An in-memory fs: `files` maps absolute path → content; directories are implied. */
function memFs(files: Record<string, string>): LaunchFs {
  const norm = (p: string): string => path.resolve(p);
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    readdirSync(dir: string): string[] {
      const d = norm(dir) + path.sep;
      const out = new Set<string>();
      for (const k of map.keys()) {
        if (k.startsWith(d)) { out.add(k.slice(d.length).split(path.sep)[0]); }
      }
      if (out.size === 0) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      return [...out];
    },
    existsSync: (p: string) => map.has(norm(p)),
    readFileSync(p: string): string {
      const v = map.get(norm(p));
      if (v === undefined) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      return v;
    },
  };
}

const EXT = path.resolve('/home/u/.vscode/extensions');
const folder = (v: string): string => path.join(EXT, `moag.agent-task-player-${v}`);
const cliOf = (v: string, rel = path.join('out', 'headless', 'cli.js')): string => path.join(folder(v), rel);

describe('moag launcher', () => {
  describe('compareVersions', () => {
    it('compares numerically: 0.9.14 beats 0.9.9', () => {
      assert.ok(compareVersions('0.9.14', '0.9.9') > 0);
      assert.ok(compareVersions('0.9.9', '0.9.14') < 0);
      assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    });

    it('a pre-release sorts below its release', () => {
      assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
      assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
    });
  });

  describe('pickCli', () => {
    it('picks the highest version, numerically', () => {
      const f = memFs({ [cliOf('0.9.9')]: '', [cliOf('0.9.14')]: '' });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), cliOf('0.9.14'));
    });

    it('skips a newer folder without a CLI', () => {
      const f = memFs({ [cliOf('0.9.14')]: '', [path.join(folder('0.9.15'), 'README.md')]: '' });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), cliOf('0.9.14'));
    });

    it('matches the folder name case-insensitively and ignores other extensions', () => {
      const upper = path.join(EXT, 'MOAG.Agent-Task-Player-0.9.15', 'out', 'headless', 'cli.js');
      const f = memFs({ [upper]: '', [path.join(EXT, 'other.ext-9.9.9', 'out', 'headless', 'cli.js')]: '' });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), upper);
    });

    it('takes the CLI path from the folder\'s package.json bin.moag', () => {
      const bundled = cliOf('1.0.0', path.join('out', 'bundle', 'cli.js'));
      const f = memFs({
        [path.join(folder('1.0.0'), 'package.json')]: JSON.stringify({ bin: { moag: './out/bundle/cli.js' } }),
        [bundled]: '',
      });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), bundled);
      assert.equal(cliPathIn(folder('1.0.0'), f), bundled);
    });

    it('falls back to out/headless/cli.js when package.json has no bin', () => {
      const f = memFs({ [path.join(folder('1.0.0'), 'package.json')]: '{}', [cliOf('1.0.0')]: '' });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), cliOf('1.0.0'));
    });

    it('uses the fixed path when no installed folder has a CLI', () => {
      const fixed = path.resolve('/dev/moag/out/headless/cli.js');
      const f = memFs({ [fixed]: '' });
      assert.equal(pickCli({ extensionsDirs: [EXT], fixedCli: fixed }, f), fixed);
    });

    it('skips a folder VS Code listed in .obsolete, case-insensitively', () => {
      const f = memFs({
        [cliOf('0.9.14')]: '', [cliOf('0.9.15')]: '',
        [path.join(EXT, '.obsolete')]: JSON.stringify({ 'MOAG.agent-task-player-0.9.15': true, 'other.ext-1.0.0': true }),
      });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), cliOf('0.9.14'));
    });

    it('an unreadable or odd .obsolete is ignored', () => {
      const f = memFs({ [cliOf('0.9.15')]: '', [path.join(EXT, '.obsolete')]: 'not json' });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, f), cliOf('0.9.15'));
      const g = memFs({ [cliOf('0.9.15')]: '', [path.join(EXT, '.obsolete')]: JSON.stringify({ 'moag.agent-task-player-0.9.15': false }) });
      assert.equal(pickCli({ extensionsDirs: [EXT] }, g), cliOf('0.9.15'));
    });

    it('returns null when nothing is found', () => {
      const f = memFs({});
      assert.equal(pickCli({ extensionsDirs: [EXT], fixedCli: path.resolve('/nope/cli.js') }, f), null);
    });
  });

  it('imports no project module: it is copied out of the extension alone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'headless', 'moag-launch.ts'), 'utf-8');
    assert.doesNotMatch(src, /\b(?:from|require\()\s*['"]\.\.?\//, 'moag-launch.ts imports a relative module');
  });
});
