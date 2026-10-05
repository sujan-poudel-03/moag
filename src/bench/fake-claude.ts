// ─── Fake `claude` CLI for benchmark dry-runs (standalone script) ───
//
//   node out/bench/fake-claude.js --moag-fake-state <state.json> [claude args...] < prompt
//
// Installed by fake-engine.ts as `claude.cmd` / `claude` in a bin directory
// that the bench prepends to the in-process server's PATH, so the REAL product
// path runs end to end — server, worker, runner, ClaudeAdapter, runCli, plan
// parsing, verify, gate stamp — and no model is ever called.
//
// Behaviour, by prompt:
//   - `--version`                → prints the bench-fake version marker.
//   - a plan prompt              → one agent task per requirement id the prompt
//                                  allows, plus one command task (the state's
//                                  planCommand) citing every id.
//   - a verify prompt            → a passing verdict.
//   - anything else (a task)     → copies the state's fixture folder into cwd.
// With `--output-format json` the reply is wrapped like Claude's JSON result,
// with `total_cost_usd: 0`. Every call is appended to `calls.jsonl` beside the
// state file. Uses only fs and path.

import * as fs from 'fs';
import * as path from 'path';

/** Printed for `--version`; the bench refuses a dry-run unless it sees `moag-bench-fake`. */
export const FAKE_CLAUDE_VERSION = '0.0.0-moag-bench-fake (Claude Code)';

const PLAN_MARKER = 'Generate a structured JSON execution plan';
const VERIFY_MARKER = '"passed": boolean';

interface FakeState {
  fixtureDir?: string | null;
  planCommand?: string | null;
}

function readState(statePath: string | null): FakeState {
  if (!statePath) { return {}; }
  try { return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as FakeState; } catch { return {}; }
}

/** Requirement ids a plan prompt allows (`citing ONLY IDs from this list: R-1, R-2.`). */
export function allowedIds(prompt: string): string[] {
  const m = /citing ONLY IDs from this list: ([^\n]*?)\. A task/.exec(prompt);
  if (!m) { return []; }
  return m[1].split(',').map((s) => s.trim()).filter((s) => /^R-\d+$/.test(s));
}

/** The plan JSON the fake planner returns for `prompt`. */
export function fakePlan(prompt: string, planCommand: string | null | undefined): Record<string, unknown> {
  const ids = allowedIds(prompt);
  const lineFor = (id: string): string => {
    const line = prompt.split('\n').find((l) => l.startsWith(`- [${id}]`));
    return line ? line.slice(2).trim() : `[${id}]`;
  };
  const tasks: Array<Record<string, unknown>> = ids.map((id, i) => ({
    id: `task-${i + 1}`,
    name: `Implement ${id}`,
    prompt: `Implement this requirement in the repository, with tests: ${lineFor(id)}`,
    status: 'pending',
    requirementIds: [id],
  }));
  if (planCommand && ids.length > 0) {
    tasks.push({
      id: 'task-tests',
      name: 'Run the test suite',
      prompt: 'Run the test suite.',
      type: 'command',
      command: planCommand,
      status: 'pending',
      requirementIds: [...ids],
      dependsOn: tasks.map((t) => t.id),
    });
  }
  return {
    version: '1.0',
    name: 'Bench fake plan',
    description: 'Deterministic plan from the benchmark fake engine.',
    playlists: [{ id: 'pl-bench', name: 'Bench delta', testPhase: false, role: 'engineer', tasks }],
  };
}

/** Copy every file of `from` into `to` (overwriting). Returns the number of files copied. */
function copyTree(from: string, to: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      n += copyTree(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      n++;
    }
  }
  return n;
}

function hasJsonOutput(args: readonly string[]): boolean {
  return args.some((a, i) => (a === '--output-format' && args[i + 1] === 'json') || a === '--output-format=json');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function main(argv: string[]): Promise<number> {
  let statePath: string | null = null;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--moag-fake-state') { statePath = argv[++i] ?? null; } else { args.push(argv[i]); }
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${FAKE_CLAUDE_VERSION}\n`);
    return 0;
  }

  const prompt = await readStdin();
  const state = readState(statePath);
  let mode: 'plan' | 'verify' | 'task';
  let text: string;
  let copied = 0;
  if (prompt.includes(PLAN_MARKER)) {
    mode = 'plan';
    text = JSON.stringify(fakePlan(prompt, state.planCommand));
  } else if (prompt.includes(VERIFY_MARKER)) {
    mode = 'verify';
    text = JSON.stringify({ passed: true, score: 100, gaps: [], suggestion: '' });
  } else {
    mode = 'task';
    if (state.fixtureDir && fs.existsSync(state.fixtureDir)) { copied = copyTree(state.fixtureDir, process.cwd()); }
    text = `Bench fake engine: applied the dry-run fixture (${copied} file${copied === 1 ? '' : 's'}).`;
  }

  if (statePath) {
    try {
      fs.appendFileSync(path.join(path.dirname(statePath), 'calls.jsonl'), JSON.stringify({
        ts: new Date().toISOString(), mode, cwd: process.cwd(), args, promptChars: prompt.length, filesCopied: copied,
      }) + '\n');
    } catch { /* the call log is best effort */ }
  }

  if (hasJsonOutput(args)) {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: text,
      total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 },
    }) + '\n');
  } else {
    process.stdout.write(`${text}\n`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`fake-claude: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
