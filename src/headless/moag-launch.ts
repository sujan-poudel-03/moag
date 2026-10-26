// ─── moag launcher — finds the installed extension's CLI at run time ───
//
// "MOAG: Install Command-Line Tool" copies this file, alone, out of the
// extension (to %LOCALAPPDATA%\moag\bin or ~/.local/share/moag) next to a
// moag-shim.json written at install time. Each `moag` call then picks the
// NEWEST installed `moag.agent-task-player-<version>` folder, so an extension
// update is picked up without reinstalling the command.
//
// The CLI's path inside a folder comes from that folder's package.json
// `bin.moag` (the build may move it); out/headless/cli.js is the fallback for a
// package.json without one.
//
// Copied alone, so: Node built-ins only, never a project module.

import * as fs from 'fs';
import * as path from 'path';

/** moag-shim.json, written next to this file by the installer. */
export interface LaunchConfig {
  /** Folders holding installed extensions (e.g. ~/.vscode/extensions). */
  extensionsDirs: string[];
  /** A CLI to use when no installed folder has one (a development checkout). */
  fixedCli?: string;
}

/** The fs calls pickCli makes; injectable for tests. */
export interface LaunchFs {
  readdirSync(dir: string): string[];
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf-8'): string;
}

const FOLDER_RE = /^moag\.agent-task-player-(\d+\.\d+\.\d+[^\\/]*)$/i;
const FALLBACK_CLI = path.join('out', 'headless', 'cli.js');

export const NOT_FOUND_MESSAGE = "MOAG extension not found. Reinstall it, then run 'MOAG: Install Command-Line Tool'.";

/**
 * Compare two versions numerically (major.minor.patch); a pre-release
 * (`1.0.0-beta`) sorts below its release. Negative when a < b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
    if (!m) { return { nums: [0, 0, 0], pre: v }; }
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) { return x.nums[i] - y.nums[i]; }
  }
  if (x.pre === y.pre) { return 0; }
  if (!x.pre) { return 1; }
  if (!y.pre) { return -1; }
  return x.pre < y.pre ? -1 : 1;
}

/** The CLI entry inside an extension folder, from its package.json `bin.moag`. */
export function cliPathIn(folder: string, fsLike: LaunchFs): string {
  try {
    const pkg = JSON.parse(fsLike.readFileSync(path.join(folder, 'package.json'), 'utf-8')) as { bin?: unknown };
    const bin = pkg.bin;
    const rel = typeof bin === 'string' ? bin
      : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).moag === 'string'
        ? (bin as Record<string, string>).moag : null;
    if (rel) { return path.resolve(folder, rel); }
  } catch { /* no or unreadable package.json: the fallback */ }
  return path.join(folder, FALLBACK_CLI);
}

/**
 * The CLI to run: in the newest installed extension folder whose CLI exists,
 * else `fixedCli` when it exists, else null.
 */
export function pickCli(cfg: LaunchConfig, fsLike: LaunchFs = fs): string | null {
  const candidates: Array<{ version: string; folder: string }> = [];
  for (const dir of cfg.extensionsDirs ?? []) {
    let names: string[];
    try { names = fsLike.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = FOLDER_RE.exec(name);
      if (m) { candidates.push({ version: m[1], folder: path.join(dir, name) }); }
    }
  }
  candidates.sort((p, q) => compareVersions(q.version, p.version));
  for (const c of candidates) {
    const cli = cliPathIn(c.folder, fsLike);
    if (fsLike.existsSync(cli)) { return cli; }
  }
  if (cfg.fixedCli && fsLike.existsSync(cfg.fixedCli)) { return cfg.fixedCli; }
  return null;
}

/** Read moag-shim.json next to this file; an empty config when it is missing or broken. */
function readConfig(): LaunchConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'moag-shim.json'), 'utf-8')) as Partial<LaunchConfig>;
    return {
      extensionsDirs: Array.isArray(raw.extensionsDirs) ? raw.extensionsDirs.filter((d): d is string => typeof d === 'string') : [],
      fixedCli: typeof raw.fixedCli === 'string' ? raw.fixedCli : undefined,
    };
  } catch {
    return { extensionsDirs: [] };
  }
}

/** Entry point when run as `node moag-launch.js …`. */
async function launch(argv: string[]): Promise<number> {
  const cli = pickCli(readConfig());
  if (!cli) {
    process.stderr.write(NOT_FOUND_MESSAGE + '\n');
    return 2;
  }
  if (argv[0] === '--print-cli-path') {
    process.stdout.write(cli + '\n');
    return 0;
  }
  // In this process, not a child: one process, and Ctrl+C reaches the CLI directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(cli) as { main?: (a: string[]) => Promise<number> };
  if (typeof mod.main !== 'function') {
    process.stderr.write(`The MOAG CLI at ${cli} has no entry point this launcher can call. Run 'MOAG: Install Command-Line Tool' again.\n`);
    return 2;
  }
  return mod.main(argv);
}

if (require.main === module) {
  launch(process.argv.slice(2)).then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (err: unknown) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
