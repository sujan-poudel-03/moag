// ─── Task Runner — state machine that plays through tasks sequentially ───

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { Plan, Playlist, Task, TaskStatus, RunnerState, EngineId, EngineResult, HistoryEntry } from '../models/types';
import { generateId } from '../models/plan';
import { getEngine } from '../adapters/index';
import { HistoryStore } from '../history/store';

/** Events emitted by the TaskRunner */
export interface RunnerEvents {
  'state-changed': (state: RunnerState) => void;
  'task-started': (task: Task, playlist: Playlist) => void;
  'task-output': (task: Task, chunk: string, stream: 'stdout' | 'stderr') => void;
  'task-completed': (task: Task, result: EngineResult) => void;
  'task-failed': (task: Task, result: EngineResult) => void;
  'playlist-completed': (playlist: Playlist) => void;
  'all-completed': () => void;
  'error': (err: Error) => void;
}

export class TaskRunner {
  private _state: RunnerState = RunnerState.Idle;
  private _emitter = new EventEmitter();
  private _abortController: AbortController | null = null;

  // Queue tracking
  private _currentPlaylistIndex = 0;
  private _currentTaskIndex = 0;
  private _plan: Plan | null = null;
  private _pauseResolve: (() => void) | null = null;

  constructor(private readonly historyStore: HistoryStore) {}

  get state(): RunnerState {
    return this._state;
  }

  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): void {
    this._emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): void {
    this._emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): void {
    this._emitter.emit(event, ...args);
  }

  private setState(state: RunnerState): void {
    this._state = state;
    this.emit('state-changed', state);
  }

  /** Start playing from the current position in the plan */
  async play(plan: Plan, playlistIndex = 0, taskIndex = 0): Promise<void> {
    if (this._state === RunnerState.Playing) {
      return;
    }

    // Resume from pause
    if (this._state === RunnerState.Paused && this._pauseResolve) {
      this.setState(RunnerState.Playing);
      this._pauseResolve();
      this._pauseResolve = null;
      return;
    }

    this._plan = plan;
    this._currentPlaylistIndex = playlistIndex;
    this._currentTaskIndex = taskIndex;
    this._abortController = new AbortController();
    this.setState(RunnerState.Playing);

    try {
      await this.runLoop();
    } catch (err) {
      if (this._state !== RunnerState.Stopping) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.setState(RunnerState.Idle);
    }
  }

  /** Play a single playlist */
  async playPlaylist(plan: Plan, playlistIndex: number): Promise<void> {
    await this.play(plan, playlistIndex, 0);
  }

  /** Play a single task */
  async playTask(plan: Plan, playlistIndex: number, taskIndex: number): Promise<void> {
    if (this._state !== RunnerState.Idle) {
      vscode.window.showWarningMessage('Runner is already active. Stop it first.');
      return;
    }

    this._plan = plan;
    this._abortController = new AbortController();
    this.setState(RunnerState.Playing);

    const playlist = plan.playlists[playlistIndex];
    const task = playlist.tasks[taskIndex];

    try {
      await this.executeTaskWithRetry(task, playlist, plan);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.setState(RunnerState.Idle);
    }
  }

  /** Pause between tasks */
  pause(): void {
    if (this._state === RunnerState.Playing) {
      this.setState(RunnerState.Paused);
    }
  }

  /** Stop execution entirely */
  stop(): void {
    if (this._state === RunnerState.Idle) {
      return;
    }
    this.setState(RunnerState.Stopping);
    this._abortController?.abort();

    // Unblock any pause wait
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
  }

  /** Reset all task statuses in the plan to Pending */
  resetPlan(plan: Plan): void {
    for (const pl of plan.playlists) {
      for (const t of pl.tasks) {
        t.status = TaskStatus.Pending;
      }
    }
  }

  // ─── Internal loop ───

  private async runLoop(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const plan = this._plan!;

    for (let pi = this._currentPlaylistIndex; pi < plan.playlists.length; pi++) {
      const playlist = plan.playlists[pi];
      this._currentPlaylistIndex = pi;

      if (this._state === RunnerState.Stopping) { return; }

      if (playlist.parallel) {
        // ─── Parallel execution: run all tasks concurrently ───
        await this.runPlaylistParallel(playlist, plan);
      } else {
        // ─── Sequential execution ───
        const startTask = pi === this._currentPlaylistIndex ? this._currentTaskIndex : 0;
        await this.runPlaylistSequential(playlist, plan, startTask);
      }

      this.emit('playlist-completed', playlist);
    }

    this.emit('all-completed');
  }

  /** Run tasks in a playlist sequentially */
  private async runPlaylistSequential(playlist: Playlist, plan: Plan, startTask: number): Promise<void> {
    for (let ti = startTask; ti < playlist.tasks.length; ti++) {
      if (this._state === RunnerState.Stopping) { return; }

      // Check for pause — wait until resumed or stopped
      if (this._state === RunnerState.Paused) {
        await new Promise<void>((resolve) => {
          this._pauseResolve = resolve;
        });
        if ((this._state as RunnerState) === RunnerState.Stopping) { return; }
      }

      const task = playlist.tasks[ti];
      this._currentTaskIndex = ti;

      // Check dependencies — skip if any dependency failed or is not completed
      if (task.dependsOn && task.dependsOn.length > 0) {
        const depStatus = this.checkDependencies(task, plan);
        if (depStatus === 'skip') {
          task.status = TaskStatus.Skipped;
          this.emit('task-output', task, `[Skipped] "${task.name}" — dependency not met\n`, 'stderr');
          this.emit('task-completed', task, { stdout: '', stderr: 'Skipped: dependency not met', exitCode: 0, durationMs: 0 });
          continue;
        }
      }

      await this.executeTaskWithRetry(task, playlist, plan);

      // Autoplay delay between tasks
      if (playlist.autoplay && ti < playlist.tasks.length - 1) {
        const delay = playlist.autoplayDelay ??
          vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('autoplayDelay', 2000);
        await this.sleep(delay);
      }
    }
  }

  /** Run all tasks in a playlist concurrently */
  private async runPlaylistParallel(playlist: Playlist, plan: Plan): Promise<void> {
    const promises = playlist.tasks.map(task => {
      if (task.dependsOn && task.dependsOn.length > 0) {
        const depStatus = this.checkDependencies(task, plan);
        if (depStatus === 'skip') {
          task.status = TaskStatus.Skipped;
          this.emit('task-output', task, `[Skipped] "${task.name}" — dependency not met\n`, 'stderr');
          return Promise.resolve();
        }
      }
      return this.executeTaskWithRetry(task, playlist, plan);
    });

    await Promise.allSettled(promises);
  }

  /** Check if all dependency tasks have completed successfully */
  private checkDependencies(task: Task, plan: Plan): 'ok' | 'skip' {
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    for (const depId of task.dependsOn ?? []) {
      const dep = allTasks.find(t => t.id === depId);
      if (!dep || dep.status === TaskStatus.Failed || dep.status === TaskStatus.Skipped) {
        return 'skip';
      }
      if (dep.status !== TaskStatus.Completed) {
        return 'skip';
      }
    }
    return 'ok';
  }

  /** Execute a task with optional retries on failure */
  private async executeTaskWithRetry(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    const maxAttempts = (task.retryCount ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.executeTask(task, playlist, plan);
      if (task.status === TaskStatus.Completed || this._state === RunnerState.Stopping) {
        return;
      }
      // Task failed — retry if attempts remain
      if (attempt < maxAttempts) {
        this.emit('task-output', task, `\n[Retry ${attempt}/${task.retryCount}] Retrying "${task.name}"...\n`, 'stderr');
        task.status = TaskStatus.Pending;
        await this.sleep(2000);
      }
    }
  }

  private async executeTask(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    // Determine which engine to use (task > playlist > plan default)
    const engineId = task.engine ?? playlist.engine ?? plan.defaultEngine;
    const engine = getEngine(engineId);
    const cwd = this.resolveCwd(task.cwd);

    // Build context-enriched prompt
    const fullPrompt = this.buildPrompt(task, cwd);

    task.status = TaskStatus.Running;
    const startedAt = new Date().toISOString();
    this.emit('task-started', task, playlist);

    try {
      const result = await engine.runTask({
        prompt: fullPrompt,
        cwd,
        files: task.files,
        signal: this._abortController?.signal,
        onOutput: (chunk, stream) => {
          this.emit('task-output', task, chunk, stream);
        },
      });

      // Run optional verify command
      if (result.exitCode === 0 && task.verifyCommand) {
        const verifyResult = await this.runVerifyCommand(task.verifyCommand, cwd);
        if (verifyResult !== 0) {
          result.exitCode = verifyResult;
          result.stderr += '\n[Verification command failed]';
        }
      }

      const finishedAt = new Date().toISOString();

      if (result.exitCode === 0) {
        task.status = TaskStatus.Completed;
        this.emit('task-completed', task, result);
      } else {
        task.status = TaskStatus.Failed;
        this.emit('task-failed', task, result);
      }

      // Record in history
      const entry: HistoryEntry = {
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        prompt: fullPrompt,
        result,
        status: task.status,
        startedAt,
        finishedAt,
      };
      this.historyStore.add(entry);
    } catch (err) {
      task.status = TaskStatus.Failed;
      const finishedAt = new Date().toISOString();
      const errMsg = err instanceof Error ? err.message : String(err);
      const guidance = this.getErrorGuidance(errMsg, engineId);
      const errorResult: EngineResult = {
        stdout: '',
        stderr: guidance ? `${errMsg}\n\n${guidance}` : errMsg,
        exitCode: 1,
        durationMs: 0,
      };
      this.emit('task-failed', task, errorResult);

      this.historyStore.add({
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        prompt: fullPrompt,
        result: errorResult,
        status: TaskStatus.Failed,
        startedAt,
        finishedAt,
      });
    }
  }

  /** Build a context-enriched prompt with file contents injected */
  private buildPrompt(task: Task, cwd: string): string {
    let prompt = task.prompt;

    if (task.files && task.files.length > 0) {
      const fileContents: string[] = [];
      for (const filePath of task.files) {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
        try {
          const content = fs.readFileSync(resolved, 'utf-8');
          fileContents.push(`--- ${filePath} ---\n${content}`);
        } catch {
          fileContents.push(`--- ${filePath} --- (file not found)`);
        }
      }
      prompt += `\n\nContext files:\n\n${fileContents.join('\n\n')}`;
    }

    return prompt;
  }

  /** Resolve working directory — relative paths are resolved against workspace root */
  private resolveCwd(taskCwd?: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (!taskCwd) {
      return root;
    }
    const path = require('path'); // eslint-disable-line @typescript-eslint/no-var-requires
    return path.isAbsolute(taskCwd) ? taskCwd : path.join(root, taskCwd);
  }

  /** Run a shell verification command and return its exit code */
  private runVerifyCommand(command: string, cwd: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn(command, [], { cwd, shell: true, stdio: 'ignore' });
      proc.on('error', () => resolve(1));
      proc.on('close', (code) => resolve(code ?? 1));
    });
  }

  /** Provide actionable guidance based on common error patterns */
  private getErrorGuidance(errorMsg: string, engineId: EngineId): string | null {
    const lower = errorMsg.toLowerCase();

    if (lower.includes('enoent') || lower.includes('not found') || lower.includes('not recognized')) {
      return `Hint: The "${engineId}" CLI does not appear to be installed or is not in your PATH. ` +
        `Check the command in Settings > agentTaskPlayer.engines.${engineId}.command`;
    }
    if (lower.includes('eacces') || lower.includes('permission denied')) {
      return `Hint: Permission denied. Ensure the "${engineId}" CLI binary is executable.`;
    }
    if (lower.includes('timeout') || lower.includes('etimedout')) {
      return `Hint: The task timed out. The AI engine may be overloaded — try again or use a different engine.`;
    }
    if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication')) {
      return `Hint: Authentication failed. Ensure your API key or credentials for "${engineId}" are configured correctly.`;
    }
    if (lower.includes('rate limit') || lower.includes('429')) {
      return `Hint: Rate limited by the "${engineId}" API. Wait a moment and try again.`;
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
