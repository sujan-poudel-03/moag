// ─── In-process hosted server for the benchmark ───
//
// The bench starts the REAL server (`startServer` from server/main.ts) inside
// its own process, so Ctrl+C can stop every job through `app.jobs.stopAll()`.
// Workers are detached; killing a separate server process on Windows would
// orphan them and their agents.
//
// The server gets a BUILT environment — a copy, never `process.env` itself:
// its data dir and projects root under the bench's out dir, a loopback
// address on a free port, a random bootstrap token, one job at a time, the
// per-call engine cap, the scenario's passthrough names, a bench git identity,
// no `CI`, and exactly one PATH key. In dry-run the PATH starts with the fake
// engine's bin dir and every directory holding a real `claude` is removed.

import * as path from 'path';
import { randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { fakeOnlyPath } from './fake-engine';

export interface LaunchOptions {
  outDir: string;
  /** Dry-run: the fake engine's bin dir (prepended to PATH; real `claude` dirs dropped). */
  fakeBinDir: string | null;
  passEnv: string[];
  maxUsdPerCall: number | null;
  /** Environment to copy (default `process.env`); never mutated. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface LaunchedServer {
  url: string;
  projectsRoot: string;
  bootstrapToken: string;
  /** The environment the server (and so its workers) was given. */
  serverEnv: NodeJS.ProcessEnv;
  /** Stop every job, then close the server. Never rejects. */
  stop(): Promise<void>;
}

/** Build the server's environment from `base` (a copy; `base` is not touched). */
export function buildServerEnv(base: NodeJS.ProcessEnv, opts: LaunchOptions): { env: NodeJS.ProcessEnv; bootstrapToken: string } {
  const env: NodeJS.ProcessEnv = {};
  let pathKey: string | null = null;
  let pathValue = '';
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) { continue; }
    const upper = k.toUpperCase();
    // CI would auto-approve ship gates; the server refuses runs with it. MOAG_* is ours to set.
    if (upper === 'CI' || upper.startsWith('MOAG_')) { continue; }
    if (upper === 'PATH') {
      if (pathKey === null) { pathKey = k; pathValue = v; }
      continue;
    }
    env[k] = v;
  }
  const bootstrapToken = randomBytes(32).toString('base64url');
  const outDir = path.resolve(opts.outDir);
  env[pathKey ?? 'PATH'] = opts.fakeBinDir ? fakeOnlyPath(pathValue, path.resolve(opts.fakeBinDir)) : pathValue;
  env.MOAG_DATA_DIR = path.join(outDir, 'server-data');
  env.MOAG_PROJECTS_ROOT = path.join(outDir, 'workspaces');
  env.MOAG_PUBLIC_URL = 'http://127.0.0.1/';
  env.MOAG_HOST = '127.0.0.1';
  env.MOAG_PORT = '0';
  env.MOAG_BOOTSTRAP_TOKEN = bootstrapToken;
  env.MOAG_MAX_CONCURRENT_JOBS = '1';
  if (opts.maxUsdPerCall !== null) { env.MOAG_MAX_USD_PER_ENGINE_CALL = String(opts.maxUsdPerCall); }
  if (opts.passEnv.length > 0) { env.MOAG_RUN_ENV_PASSTHROUGH = opts.passEnv.join(','); }
  env.GIT_AUTHOR_NAME = 'moag-bench';
  env.GIT_AUTHOR_EMAIL = 'bench@moag.invalid';
  env.GIT_COMMITTER_NAME = 'moag-bench';
  env.GIT_COMMITTER_EMAIL = 'bench@moag.invalid';
  return { env, bootstrapToken };
}

/** Start the real server in this process. */
export async function launchServer(opts: LaunchOptions): Promise<LaunchedServer> {
  const { env, bootstrapToken } = buildServerEnv(opts.baseEnv ?? process.env, opts);
  // Lazy: loading the server pulls in the whole app; `moag bench --help` should not.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startServer } = require('../server/main') as typeof import('../server/main');
  // startServer scrubs MOAG_BOOTSTRAP_TOKEN from the env it is given and keeps that object
  // as the workers' base env: the scrubbed copy is what the bench exposes for gate runs.
  const serverEnv: NodeJS.ProcessEnv = { ...env };
  const { app } = await startServer(serverEnv);
  const { port } = app.server.address() as AddressInfo;
  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    projectsRoot: env.MOAG_PROJECTS_ROOT as string,
    bootstrapToken,
    serverEnv,
    async stop(): Promise<void> {
      if (stopped) { return; }
      stopped = true;
      try {
        await app.jobs.stopAll();
      } catch { /* best effort: closing the server still runs */ } finally {
        await new Promise<void>((resolve) => {
          app.server.close(() => resolve());
          app.server.closeAllConnections?.();
        });
      }
    },
  };
}
