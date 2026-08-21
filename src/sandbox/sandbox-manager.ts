// ─── Sandbox lifecycle manager ───
// Manages dev server (web) or emulator (mobile) lifecycle.
// Emits 'state-changed' and 'output' events for the dashboard to react to.

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { detectProject, ProjectInfo } from './project-detector';
import { SandboxConfig } from '../models/types';
// One tree-kill implementation for the whole extension. `runner/evidence` is
// dependency-free (fs/path/child_process only) so this import adds no cycle.
import { killProcess } from '../utils/process-kill';

export type SandboxStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface SandboxState {
  status: SandboxStatus;
  projectInfo: ProjectInfo | null;
  /** Live URL for web projects — null for mobile/desktop/stopped */
  url: string | null;
  error: string | null;
  /** Path to the most recently captured screenshot */
  lastScreenshotPath: string | null;
}

/**
 * Probe whether something is already listening on `port`.
 *
 * Resolves false — never rejects — on connection refused, on an unreachable host
 * (via the timeout branch) and on any socket error, so callers can treat it as a
 * plain boolean question. Exported so the headless CLI can preflight a port before
 * launching a sandbox of its own.
 */
export function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export class SandboxManager extends EventEmitter {
  private _process: ChildProcess | null = null;
  private _backgroundProcesses: ChildProcess[] = [];
  private _state: SandboxState = {
    status: 'stopped',
    projectInfo: null,
    url: null,
    error: null,
    lastScreenshotPath: null,
  };

  get state(): SandboxState {
    return { ...this._state };
  }

  /**
   * Detect project type and start the appropriate sandbox environment.
   * Pass an optional SandboxConfig from the plan to override auto-detection.
   */
  async launch(cwd: string, config?: SandboxConfig): Promise<void> {
    if (this._state.status === 'running' || this._state.status === 'starting') {
      return;
    }

    // Build a ProjectInfo from the plan's sandbox config if provided
    let info: ProjectInfo;
    if (config?.command) {
      info = { type: 'web', framework: 'Custom', devCommand: config.command, defaultPort: config.port ?? 3000 };
    } else if (config?.targets && config.targets.length > 0) {
      // Launch first target (multi-target support: start all and track first URL)
      const first = config.targets[0];
      const effectiveCwd = first.cwd ? (path.isAbsolute(first.cwd) ? first.cwd : path.join(cwd, first.cwd)) : cwd;
      info = { type: 'web', framework: first.name, devCommand: first.command, defaultPort: first.port ?? 3000, resolvedCwd: effectiveCwd };
      // Launch additional targets in background and track them for proper stop().
      for (let i = 1; i < config.targets.length; i++) {
        const t = config.targets[i];
        const tCwd = t.cwd ? (path.isAbsolute(t.cwd) ? t.cwd : path.join(cwd, t.cwd)) : cwd;
        this._spawnBackground(t.command, tCwd);
      }
    } else {
      info = detectProject(cwd);
    }

    this._setState({
      status: 'starting',
      projectInfo: info,
      url: null,
      error: null,
      lastScreenshotPath: this._state.lastScreenshotPath,
    });

    if (info.type === 'unknown' || !info.devCommand) {
      const hint = info.framework === 'monorepo'
        ? 'Monorepo detected but no runnable app found. Add a "sandbox" field to your plan JSON with explicit targets.'
        : 'Could not detect project type. Add a package.json or pubspec.yaml, or set "sandbox.command" in your plan.';
      this._setState({ ...this._state, status: 'error', error: hint });
      return;
    }

    const effectiveCwd = info.resolvedCwd ?? cwd;
    if (info.type === 'web') {
      this._launchWebServer(effectiveCwd, info);
    } else if (info.type === 'mobile') {
      this._launchMobileApp(effectiveCwd, info);
    } else if (info.type === 'desktop') {
      this._launchDesktopApp(effectiveCwd, info);
    }
  }

  /** Start a background process without tracking its URL or state. */
  private _spawnBackground(command: string, cwd: string): void {
    const [cmd, ...args] = command.split(' ');
    const proc = spawn(cmd, args, { cwd, shell: true, stdio: 'ignore', detached: false });
    this._backgroundProcesses.push(proc);
    const cleanup = () => {
      this._backgroundProcesses = this._backgroundProcesses.filter(p => p !== proc);
    };
    proc.on('exit', cleanup);
    proc.on('error', cleanup);
  }

  /**
   * Stop the running sandbox process and every background target.
   *
   * Uses the runner's tree-kill: dev servers are spawned through a shell, so the
   * pid we hold is the shell. A bare SIGTERM kills the shell and ORPHANS the real
   * server, which keeps holding the port — and a later UAT run would then pass
   * green against a stale build. Each kill is isolated so one failure cannot
   * prevent the rest from being killed.
   */
  stop(): void {
    if (this._process) {
      try {
        killProcess(this._process);
      } catch {
        // ignore — the process may already be gone
      }
      this._process = null;
    }
    for (const proc of this._backgroundProcesses) {
      try {
        killProcess(proc);
      } catch {
        // ignore
      }
    }
    this._backgroundProcesses = [];
    this._setState({ ...this._state, status: 'stopped', url: null, error: null });
  }

  /** Called by screenshot.ts after a capture succeeds. */
  setLastScreenshotPath(screenshotPath: string): void {
    this._setState({ ...this._state, lastScreenshotPath: screenshotPath });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _launchWebServer(cwd: string, info: ProjectInfo): void {
    const [cmd, ...args] = info.devCommand.split(' ');
    this._process = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onOutput = (chunk: Buffer): void => {
      const text = chunk.toString();
      this.emit('output', text);

      if (this._state.status !== 'running') {
        const url = this._detectUrl(text, info.defaultPort);
        if (url) {
          this._setState({ ...this._state, status: 'running', url });
        }
      }
    };

    this._process.stdout?.on('data', onOutput);
    this._process.stderr?.on('data', onOutput);

    this._process.on('exit', (code) => {
      this._process = null;
      if (this._state.status !== 'stopped') {
        const failed = code !== null && code !== 0;
        this._setState({
          ...this._state,
          status: failed ? 'error' : 'stopped',
          error: failed ? `Dev server exited with code ${code}. Check the sandbox output for details.` : null,
        });
      }
    });

    this._process.on('error', (err) => {
      this._process = null;
      this._setState({ ...this._state, status: 'error', error: `Failed to start process: ${err.message}` });
    });

    // Fallback: poll port after 30s. If still starting and port is closed, emit a timeout error.
    setTimeout(async () => {
      if (this._state.status !== 'starting') { return; }
      if (info.defaultPort > 0) {
        const open = await this._isPortOpen(info.defaultPort);
        if (open) {
          this._setState({ ...this._state, status: 'running', url: `http://localhost:${info.defaultPort}` });
          return;
        }
      }
      // Still starting after 30s — emit a clear timeout error
      const cmd = info.devCommand;
      this._setState({
        ...this._state,
        status: 'error',
        error: `Sandbox timed out after 30s. Command "${cmd}" did not print a URL or open a port. Check the output panel for errors.`,
      });
    }, 30000);
  }

  private _launchMobileApp(cwd: string, info: ProjectInfo): void {
    const [cmd, ...args] = info.devCommand.split(' ');
    this._process = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._process.stdout?.on('data', (chunk: Buffer) => this.emit('output', chunk.toString()));
    this._process.stderr?.on('data', (chunk: Buffer) => this.emit('output', chunk.toString()));

    this._process.on('exit', (code) => {
      this._process = null;
      if (this._state.status !== 'stopped') {
        const failed = code !== null && code !== 0;
        this._setState({
          ...this._state,
          status: failed ? 'error' : 'stopped',
          error: failed ? `Process exited with code ${code}. Check the sandbox output for details.` : null,
        });
      }
    });

    this._process.on('error', (err) => {
      this._process = null;
      this._setState({ ...this._state, status: 'error', error: `Failed to start process: ${err.message}` });
    });

    this._setState({ ...this._state, status: 'running' });
  }

  private _launchDesktopApp(cwd: string, info: ProjectInfo): void {
    // Same pattern as mobile — just spawn and mark running
    this._launchMobileApp(cwd, info);
  }

  /** Parse common dev-server output to extract the URL. */
  private _detectUrl(text: string, fallbackPort: number): string | null {
    const patterns = [
      /https?:\/\/localhost:\d+/,
      /https?:\/\/127\.0\.0\.1:\d+/,
      /Local:\s+(https?:\/\/[^\s]+)/,
      /listening on\s+(https?:\/\/[^\s]+)/i,
      /running at\s+(https?:\/\/[^\s]+)/i,
      /started on\s+(https?:\/\/[^\s]+)/i,
      /server started at\s+(https?:\/\/[^\s]+)/i,
      /➜\s+Local:\s+(https?:\/\/[^\s]+)/,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) { return m[1] ?? m[0]; }
    }
    // Heuristic: "ready", "compiled", "listening" + default port
    if (fallbackPort > 0 && /ready|compiled|started|listening/i.test(text)) {
      return `http://localhost:${fallbackPort}`;
    }
    return null;
  }

  private _isPortOpen(port: number): Promise<boolean> {
    return isPortOpen(port);
  }

  private _setState(next: SandboxState): void {
    this._state = next;
    this.emit('state-changed', this._state);
  }
}
