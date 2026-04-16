// ─── Sandbox lifecycle manager ───
// Manages dev server (web) or emulator (mobile) lifecycle.
// Emits 'state-changed' and 'output' events for the dashboard to react to.

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import { detectProject, ProjectInfo } from './project-detector';

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

export class SandboxManager extends EventEmitter {
  private _process: ChildProcess | null = null;
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

  /** Detect project type and start the appropriate sandbox environment. */
  async launch(cwd: string): Promise<void> {
    if (this._state.status === 'running' || this._state.status === 'starting') {
      return;
    }

    const info = detectProject(cwd);
    this._setState({
      status: 'starting',
      projectInfo: info,
      url: null,
      error: null,
      lastScreenshotPath: this._state.lastScreenshotPath,
    });

    if (info.type === 'unknown' || !info.devCommand) {
      this._setState({
        ...this._state,
        status: 'error',
        error: 'Could not detect project type. Add a package.json or pubspec.yaml.',
      });
      return;
    }

    if (info.type === 'web') {
      this._launchWebServer(cwd, info);
    } else if (info.type === 'mobile') {
      this._launchMobileApp(cwd, info);
    } else if (info.type === 'desktop') {
      this._launchDesktopApp(cwd, info);
    }
  }

  /** Stop the running sandbox process. */
  stop(): void {
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }
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
        this._setState({
          ...this._state,
          status: 'stopped',
          error: code !== 0 ? `Dev server exited with code ${code}` : null,
        });
      }
    });

    this._process.on('error', (err) => {
      this._process = null;
      this._setState({ ...this._state, status: 'error', error: err.message });
    });

    // Fallback: poll port after 12s in case no URL is printed to stdout
    setTimeout(async () => {
      if (this._state.status === 'starting' && info.defaultPort > 0) {
        const open = await this._isPortOpen(info.defaultPort);
        if (open) {
          this._setState({
            ...this._state,
            status: 'running',
            url: `http://localhost:${info.defaultPort}`,
          });
        }
      }
    }, 12000);
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
        this._setState({
          ...this._state,
          status: 'stopped',
          error: code !== 0 ? `Process exited with code ${code}` : null,
        });
      }
    });

    this._process.on('error', (err) => {
      this._process = null;
      this._setState({ ...this._state, status: 'error', error: err.message });
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
    return new Promise((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.setTimeout(1500);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
  }

  private _setState(next: SandboxState): void {
    this._state = next;
    this.emit('state-changed', this._state);
  }
}
