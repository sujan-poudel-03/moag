// ─── Task Runner — state machine that plays through tasks sequentially ───

import * as vscode from 'vscode';
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
      await this.executeTask(task, playlist, plan);
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
    const plan = this._plan!;

    for (let pi = this._currentPlaylistIndex; pi < plan.playlists.length; pi++) {
      const playlist = plan.playlists[pi];
      const startTask = pi === this._currentPlaylistIndex ? this._currentTaskIndex : 0;

      for (let ti = startTask; ti < playlist.tasks.length; ti++) {
        // Check for stop
        if (this._state === RunnerState.Stopping) {
          return;
        }

        // Check for pause — wait until resumed or stopped
        if (this._state === RunnerState.Paused) {
          await new Promise<void>((resolve) => {
            this._pauseResolve = resolve;
          });
          // After resume, state may have been set to Stopping via stop()
          if ((this._state as RunnerState) === RunnerState.Stopping) {
            return;
          }
        }

        const task = playlist.tasks[ti];
        this._currentPlaylistIndex = pi;
        this._currentTaskIndex = ti;

        await this.executeTask(task, playlist, plan);

        // Autoplay delay between tasks
        if (playlist.autoplay && ti < playlist.tasks.length - 1) {
          const delay = playlist.autoplayDelay ??
            vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('autoplayDelay', 2000);
          await this.sleep(delay);
        }
      }

      this.emit('playlist-completed', playlist);
    }

    this.emit('all-completed');
  }

  private async executeTask(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    // Determine which engine to use (task > playlist > plan default)
    const engineId = task.engine ?? playlist.engine ?? plan.defaultEngine;
    const engine = getEngine(engineId);
    const cwd = this.resolveCwd(task.cwd);

    // Build context-enriched prompt
    const fullPrompt = this.buildPrompt(task);

    task.status = TaskStatus.Running;
    const startedAt = new Date().toISOString();
    this.emit('task-started', task, playlist);

    try {
      const result = await engine.runTask({
        prompt: fullPrompt,
        cwd,
        files: task.files,
        signal: this._abortController?.signal,
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
      const errorResult: EngineResult = {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
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

  /** Build a context-enriched prompt for the engine */
  private buildPrompt(task: Task): string {
    let prompt = task.prompt;

    // Add file references if specified
    if (task.files && task.files.length > 0) {
      prompt += `\n\nRelevant files:\n${task.files.map(f => `- ${f}`).join('\n')}`;
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
    const path = require('path');
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
