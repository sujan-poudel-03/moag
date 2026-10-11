// ─── Tunnel: keep cloudflared running ───
//
// Optional. With `tunnel.token_file` in host.json, the agent runs
// `cloudflared tunnel --no-autoupdate run` and restarts it with backoff when it exits. The tunnel's
// public hostname (`*.<preview domain>`) and its target (`http://127.0.0.1:<gateway port>`) are set
// in Cloudflare; the token only identifies the tunnel. Without `tunnel`, run cloudflared as its own
// service — the same thing, supervised by systemd instead (docs/host-agent.md shows both).
//
// The token is read from its file and given to cloudflared alone, as TUNNEL_TOKEN. Nothing else
// the agent starts receives it (compose.ts childEnv strips it everywhere else).
// Imports node built-ins only; never vscode.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';

import { childEnv } from './compose';

const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 120_000;
/** A run this long counts as healthy, so the next failure starts the backoff over. */
const HEALTHY_AFTER_MS = 60_000;

export interface TunnelDeps {
  tokenFile: string;
  spawnFn?: typeof spawn;
  readFile?: (f: string) => string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoff = BACKOFF_START_MS;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: TunnelDeps) {
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  private launch(): void {
    if (this.stopped) { return; }
    let token: string;
    try {
      token = (this.deps.readFile ?? ((f: string): string => fs.readFileSync(f, 'utf-8')))(this.deps.tokenFile).trim();
    } catch {
      this.log(`moag host: cannot read the tunnel token file ${this.deps.tokenFile}; previews are unreachable until it exists.`);
      return this.retry();
    }
    if (!token) { this.log('moag host: the tunnel token file is empty.'); return this.retry(); }

    const startedAt = Date.now();
    const env = { ...childEnv(this.deps.env ?? process.env), TUNNEL_TOKEN: token };
    const child = (this.deps.spawnFn ?? spawn)('cloudflared', ['tunnel', '--no-autoupdate', 'run'], { env, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    this.child = child;
    child.stderr?.on('data', () => { /* cloudflared logs to stderr; drained so it never blocks */ });
    child.on('error', (err) => {
      this.log(`moag host: could not start cloudflared (${err.message}). Is it installed?`);
    });
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) { return; }
      if (Date.now() - startedAt >= HEALTHY_AFTER_MS) { this.backoff = BACKOFF_START_MS; }
      this.log(`moag host: cloudflared exited (${code ?? 'signal'}); restarting in ${Math.round(this.backoff / 1000)}s.`);
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped) { return; }
    this.timer = setTimeout(() => this.launch(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); }
    this.child?.kill();
  }

  running(): boolean {
    return this.child !== null;
  }
}
