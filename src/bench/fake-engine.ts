// ─── Fake engine installation for benchmark dry-runs ───
//
// Writes a `claude` shim (claude.cmd on Windows, an sh script elsewhere) into
// a bench-owned bin directory. The shim runs `fake-claude.js` with the current
// Node and a per-bench state file, so a server whose PATH starts with that
// directory runs the whole real product path at zero cost. The fake reports
// FAKE_VERSION_MARKER in `claude --version`; the bench checks it before any
// dry-run step and refuses a paid run that sees it.

import * as fs from 'fs';
import * as path from 'path';

/** Substring of the fake's `--version` output. */
export const FAKE_VERSION_MARKER = 'moag-bench-fake';

export interface FakeEngine {
  binDir: string;
  statePath: string;
  /** One JSON line per fake invocation. */
  callsPath: string;
  /** Point the fake at this version's fixture folder and planner test command. */
  setVersion(fixtureDir: string | null, planCommand: string | null): void;
}

/** Default location of the compiled fake (`out/bench/fake-claude.js`). */
export function defaultFakeScript(): string {
  return path.join(__dirname, 'fake-claude.js');
}

/** Quote for a POSIX sh single-quoted string. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Install the fake `claude` into `binDir` (created if missing). `script` is the
 * compiled fake (tests pass a transpiled copy). Throws when the script is missing.
 */
export function installFakeEngine(binDir: string, script: string = defaultFakeScript()): FakeEngine {
  if (!fs.existsSync(script)) { throw new Error(`fake engine script not found: ${script} (run npm run compile)`); }
  fs.mkdirSync(binDir, { recursive: true });
  const statePath = path.join(binDir, 'fake-state.json');
  const callsPath = path.join(binDir, 'calls.jsonl');
  const node = process.execPath;
  fs.writeFileSync(
    path.join(binDir, 'claude.cmd'),
    `@"${node}" "${script}" --moag-fake-state "${statePath}" %*\r\n@exit /b %errorlevel%\r\n`,
  );
  const sh = path.join(binDir, 'claude');
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(script)} --moag-fake-state ${shQuote(statePath)} "$@"\n`);
  try { fs.chmodSync(sh, 0o755); } catch { /* not supported (Windows) */ }
  const engine: FakeEngine = {
    binDir,
    statePath,
    callsPath,
    setVersion(fixtureDir, planCommand) {
      fs.writeFileSync(statePath, JSON.stringify({ fixtureDir, planCommand }, null, 2));
    },
  };
  engine.setVersion(null, null);
  return engine;
}

/** Parsed lines of the fake's call log (missing file → []). */
export function readFakeCalls(engine: Pick<FakeEngine, 'callsPath'>): Array<Record<string, unknown>> {
  let text: string;
  try { text = fs.readFileSync(engine.callsPath, 'utf-8'); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* torn line */ }
  }
  return out;
}

/** Executable names that would satisfy a `claude` lookup in a PATH directory. */
const CLAUDE_FILE_NAMES = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.com', 'claude.ps1'];

/**
 * `pathValue` with every directory that holds a real `claude` executable
 * removed, and `binDir` prepended. Dry-run only: it makes the real CLI
 * unreachable from the server and its workers, whatever lookup they use.
 */
export function fakeOnlyPath(pathValue: string, binDir: string): string {
  const keep = pathValue.split(path.delimiter).filter((d) => {
    if (!d.trim()) { return false; }
    if (path.resolve(d) === path.resolve(binDir)) { return false; }
    return !CLAUDE_FILE_NAMES.some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } });
  });
  return [binDir, ...keep].join(path.delimiter);
}
