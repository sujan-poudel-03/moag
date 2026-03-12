import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { EventEmitter } from 'events';
import { ChildProcess, execSync, spawn } from 'child_process';
import {
  Plan,
  Playlist,
  Task,
  TaskStatus,
  RunnerState,
  EngineId,
  EngineResult,
  HistoryEntry,
  FailurePolicy,
  TaskArtifact,
  TaskType,
  VerificationResult,
} from '../models/types';
import { generateId } from '../models/plan';
import { selectModel, ReasoningPreset } from '../models/model-selector';
import { getEngine } from '../adapters/index';
import { HistoryStore } from '../history/store';
import { buildContext, getContextSettings } from '../context/context-builder';

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_SERVICE_STARTUP_TIMEOUT_MS = 60_000;

export interface RunnerEvents {
  'state-changed': (state: RunnerState) => void;
  'task-started': (task: Task, playlist: Playlist, fullPrompt: string) => void;
  'task-output': (task: Task, chunk: string, stream: 'stdout' | 'stderr') => void;
  'task-completed': (task: Task, result: EngineResult) => void;
  'task-failed': (task: Task, result: EngineResult) => void;
  'playlist-completed': (playlist: Playlist) => void;
  'all-completed': () => void;
  'error': (err: Error) => void;
}

interface ServiceHandle {
  taskId: string;
  taskName: string;
  command: string;
  cwd: string;
  startedAt: string;
  port?: number;
  healthCheckUrl?: string;
  readyPattern?: string;
  proc: ChildProcess;
}

interface CommandRunOptions {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export class TaskRunner {
  private _state: RunnerState = RunnerState.Idle;
  private _emitter = new EventEmitter();
  private _abortController: AbortController | null = null;
  private _currentPlaylistIndex = 0;
  private _currentTaskIndex = 0;
  private _plan: Plan | null = null;
  private _pauseResolve: (() => void) | null = null;
  private _playLock = false;
  private _taskGitRefs = new Map<string, { ref: string; cwd: string }>();
  private _serviceProcesses = new Map<string, ServiceHandle>();
  private _currentRunId: string | null = null;

  constructor(private readonly historyStore: HistoryStore) {}

  get currentRunId(): string | null {
    return this._currentRunId;
  }

  getTaskGitRef(taskId: string): { ref: string; cwd: string } | undefined {
    return this._taskGitRefs.get(taskId);
  }

  getRunningServices(): Array<Omit<ServiceHandle, 'proc'>> {
    return [...this._serviceProcesses.values()].map(({ proc: _proc, ...service }) => service);
  }

  stopAllServices(): void {
    for (const service of this._serviceProcesses.values()) {
      this.killProcess(service.proc);
    }
    this._serviceProcesses.clear();
  }

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

  async play(plan: Plan, playlistIndex = 0, taskIndex = 0): Promise<void> {
    if (this._state === RunnerState.Playing) {
      return;
    }

    if (this._state === RunnerState.Paused && this._pauseResolve) {
      this.setState(RunnerState.Playing);
      this._pauseResolve();
      this._pauseResolve = null;
      return;
    }

    if (this._playLock) {
      return;
    }
    this._playLock = true;

    this._plan = plan;
    this._currentPlaylistIndex = playlistIndex;
    this._currentTaskIndex = taskIndex;
    this._abortController = new AbortController();
    this._currentRunId = generateId();
    this.setState(RunnerState.Playing);

    try {
      await this.runLoop();
    } catch (err) {
      if (this.state !== RunnerState.Stopping) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  async playPlaylist(plan: Plan, playlistIndex: number): Promise<void> {
    await this.play(plan, playlistIndex, 0);
  }

  async playTask(plan: Plan, playlistIndex: number, taskIndex: number): Promise<void> {
    if (this._state !== RunnerState.Idle) {
      vscode.window.showWarningMessage('Runner is already active. Stop it first.');
      return;
    }
    if (this._playLock) {
      return;
    }
    this._playLock = true;

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
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  async playTasks(plan: Plan, taskList: Array<{ playlistIndex: number; taskIndex: number }>): Promise<void> {
    if (this._state !== RunnerState.Idle) {
      vscode.window.showWarningMessage('Runner is already active. Stop it first.');
      return;
    }
    if (this._playLock) {
      return;
    }
    this._playLock = true;

    this._plan = plan;
    this._abortController = new AbortController();
    this.setState(RunnerState.Playing);

    try {
      for (const { playlistIndex, taskIndex } of taskList) {
        if (this.state === RunnerState.Stopping) {
          break;
        }

        if (this.state === RunnerState.Paused) {
          await new Promise<void>((resolve) => {
            this._pauseResolve = resolve;
          });
          if (this.isStopping()) {
            break;
          }
        }

        const playlist = plan.playlists[playlistIndex];
        const task = playlist?.tasks[taskIndex];
        if (!playlist || !task) {
          continue;
        }

        await this.executeTaskWithRetry(task, playlist, plan);
      }
      this.emit('all-completed');
    } catch (err) {
      if (this.state !== RunnerState.Stopping) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._playLock = false;
      this._abortController = null;
      this.setState(RunnerState.Idle);
    }
  }

  pause(): void {
    if (this._state === RunnerState.Playing) {
      this.setState(RunnerState.Paused);
    }
  }

  stop(): void {
    if (this._state === RunnerState.Idle) {
      return;
    }
    this.setState(RunnerState.Stopping);
    this._abortController?.abort();

    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
  }

  resetPlan(plan: Plan): void {
    for (const pl of plan.playlists) {
      for (const t of pl.tasks) {
        t.status = TaskStatus.Pending;
      }
    }
  }

  private async runLoop(): Promise<void> {
    const plan = this._plan!;
    const concurrentPlaylists = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<number>('parallelPlaylists', 1);

    if (concurrentPlaylists > 1 && plan.playlists.length > 1) {
      await this.runPlaylistsConcurrently(plan, concurrentPlaylists);
    } else {
      await this.runPlaylistsSequentially(plan);
    }

    this.emit('all-completed');
  }

  private async runPlaylistsSequentially(plan: Plan): Promise<void> {
    for (let pi = this._currentPlaylistIndex; pi < plan.playlists.length; pi++) {
      const playlist = plan.playlists[pi];
      this._currentPlaylistIndex = pi;

      if (this.state === RunnerState.Stopping) {
        return;
      }

      if (playlist.parallel) {
        await this.runPlaylistParallel(playlist, plan);
      } else {
        const startTask = pi === this._currentPlaylistIndex ? this._currentTaskIndex : 0;
        await this.runPlaylistSequential(playlist, plan, startTask);
      }

      this.emit('playlist-completed', playlist);
    }
  }

  private async runPlaylistsConcurrently(plan: Plan, maxConcurrent: number): Promise<void> {
    const playlists = plan.playlists.slice(this._currentPlaylistIndex);
    let running = 0;
    let nextIndex = 0;

    await new Promise<void>((resolve) => {
      const startNext = () => {
        while (running < maxConcurrent && nextIndex < playlists.length && this.state !== RunnerState.Stopping) {
          const playlist = playlists[nextIndex];
          nextIndex++;
          running++;

          const runPlaylist = playlist.parallel
            ? this.runPlaylistParallel(playlist, plan)
            : this.runPlaylistSequential(playlist, plan, 0);

          runPlaylist.then(() => {
            this.emit('playlist-completed', playlist);
            running--;
            if (running === 0 && (nextIndex >= playlists.length || this.state === RunnerState.Stopping)) {
              resolve();
            } else {
              startNext();
            }
          }).catch(() => {
            running--;
            if (running === 0) {
              resolve();
            } else {
              startNext();
            }
          });
        }

        if (running === 0) {
          resolve();
        }
      };

      startNext();
    });
  }

  private async runPlaylistSequential(playlist: Playlist, plan: Plan, startTask: number): Promise<void> {
    for (let ti = startTask; ti < playlist.tasks.length; ti++) {
      if (this.state === RunnerState.Stopping) {
        return;
      }

      if (this.state === RunnerState.Paused) {
        if (this._pauseResolve) {
          this._pauseResolve();
        }
        await new Promise<void>((resolve) => {
          this._pauseResolve = resolve;
        });
        if (this.isStopping()) {
          return;
        }
      }

      const task = playlist.tasks[ti];
      this._currentTaskIndex = ti;

      if (task.status === TaskStatus.Completed || task.status === TaskStatus.Skipped) {
        continue;
      }

      if (task.dependsOn && task.dependsOn.length > 0) {
        const depStatus = this.checkDependencies(task, plan);
        if (depStatus === 'skip') {
          task.status = TaskStatus.Skipped;
          this.emit('task-output', task, `[Skipped] "${task.name}" - dependency not met\n`, 'stderr');
          this.emit('task-completed', task, { stdout: '', stderr: 'Skipped: dependency not met', exitCode: 0, durationMs: 0 });
          continue;
        }
      }

      await this.executeTaskWithRetry(task, playlist, plan);

      if (this.isStopping()) {
        return;
      }

      if (playlist.autoplay && ti < playlist.tasks.length - 1) {
        const delay = playlist.autoplayDelay ??
          vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('autoplayDelay', 2000);
        await this.sleep(delay);
      }
    }
  }

  private async runPlaylistParallel(playlist: Playlist, plan: Plan): Promise<void> {
    const taskPromises = new Map<string, Promise<void>>();

    for (const task of playlist.tasks) {
      const promise = (async () => {
        if (task.dependsOn && task.dependsOn.length > 0) {
          for (const depId of task.dependsOn) {
            const depPromise = taskPromises.get(depId);
            if (depPromise) {
              await depPromise;
            }
          }
          const depStatus = this.checkDependencies(task, plan);
          if (depStatus === 'skip') {
            task.status = TaskStatus.Skipped;
            this.emit('task-output', task, `[Skipped] "${task.name}" - dependency not met\n`, 'stderr');
            return;
          }
        }
        await this.executeTaskWithRetry(task, playlist, plan);
      })();
      taskPromises.set(task.id, promise);
    }

    await Promise.allSettled([...taskPromises.values()]);
  }

  private checkDependencies(task: Task, plan: Plan): 'ok' | 'skip' {
    const allTasks = plan.playlists.flatMap(pl => pl.tasks);
    for (const depId of task.dependsOn ?? []) {
      const dep = allTasks.find(t => t.id === depId);
      if (!dep || dep.status === TaskStatus.Failed || dep.status === TaskStatus.Skipped || dep.status === TaskStatus.Blocked) {
        return 'skip';
      }
      if (dep.status !== TaskStatus.Completed) {
        return 'skip';
      }
    }
    return 'ok';
  }

  private async executeTaskWithRetry(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    const maxAttempts = (task.retryCount ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.executeTask(task, playlist, plan);
      if (task.status === TaskStatus.Completed || this.state === RunnerState.Stopping) {
        return;
      }
      if (attempt < maxAttempts) {
        this.emit('task-output', task, `\n[Retry ${attempt}/${task.retryCount}] Retrying "${task.name}"...\n`, 'stderr');
        task.status = TaskStatus.Pending;
        await this.sleep(2000);
      }
    }
  }

  private async executeTask(task: Task, playlist: Playlist, plan: Plan): Promise<void> {
    const taskType = this.getTaskType(task);
    const engineId = task.engine ?? playlist.engine ?? plan.defaultEngine;
    const cwd = this.resolveCwd(task.cwd);
    const executionDescription = taskType === 'agent'
      ? this.buildPrompt(task, cwd, plan, playlist)
      : this.buildTaskDescription(task);

    task.status = TaskStatus.Running;
    const startedAt = new Date().toISOString();
    this.emit('task-started', task, playlist, executionDescription);

    const gitRef = await this.captureGitRef(cwd);
    if (gitRef) {
      this._taskGitRefs.set(task.id, { ref: gitRef, cwd });
    }

    const taskAbort = new AbortController();
    const taskTimeoutMs = taskType === 'service'
      ? (task.startupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS)
      : vscode.workspace.getConfiguration('agentTaskPlayer').get<number>('taskTimeoutMs', DEFAULT_TASK_TIMEOUT_MS);
    const timeoutId = setTimeout(() => taskAbort.abort(), taskTimeoutMs);
    const onParentAbort = () => taskAbort.abort();
    this._abortController?.signal.addEventListener('abort', onParentAbort, { once: true });

    let verification: VerificationResult | undefined;
    let artifacts: TaskArtifact[] | undefined;

    try {
      let result = await this.runTaskByType(taskType, task, engineId, cwd, executionDescription, taskAbort.signal);

      if (taskAbort.signal.aborted && !this._abortController?.signal.aborted) {
        result = {
          ...result,
          stderr: (result.stderr || '') + `\n[Task timed out after ${Math.round(taskTimeoutMs / 1000)}s]`,
          exitCode: 124,
          durationMs: taskTimeoutMs,
        };
      }

      if (result.exitCode === 0 && task.verifyCommand && taskType !== 'check') {
        this.emit('task-output', task, `\n-- Verify: ${task.verifyCommand} --\n`, 'stdout');
        verification = await this.runVerification(task.verifyCommand, cwd, task.env, taskAbort.signal, task);
        if (verification.output) {
          this.emit('task-output', task, verification.output, verification.passed ? 'stdout' : 'stderr');
        }
        if (!verification.passed) {
          result = {
            ...result,
            exitCode: verification.exitCode,
            stderr: (result.stderr ? result.stderr + '\n' : '') +
              `[Verification command failed (exit ${verification.exitCode})]\n${verification.output}`,
          };
        }
      }

      if (task.expectedArtifacts && task.expectedArtifacts.length > 0) {
        artifacts = this.captureArtifacts(task.expectedArtifacts, cwd);
        const missingArtifacts = artifacts.filter(artifact => !artifact.exists);
        if (missingArtifacts.length > 0 && result.exitCode === 0) {
          result = {
            ...result,
            exitCode: 2,
            stderr: (result.stderr ? result.stderr + '\n' : '') +
              `[Missing expected artifacts]\n${missingArtifacts.map(artifact => artifact.target).join('\n')}`,
          };
          this.emit('task-output', task, `\n[Artifacts] Missing: ${missingArtifacts.map(artifact => artifact.target).join(', ')}\n`, 'stderr');
        } else if (artifacts.length > 0) {
          this.emit(
            'task-output',
            task,
            `\n[Artifacts] Verified ${artifacts.filter(artifact => artifact.exists).length}/${artifacts.length} expected artifacts\n`,
            'stdout',
          );
        }
      }

      result = {
        ...result,
        summary: this.buildResultSummary(task, result, verification, artifacts),
      };

      const { changedFiles, codeChanges } = await this.captureGitDiff(gitRef, cwd);
      const finishedAt = new Date().toISOString();

      task.status = this.resolveFinalStatus(task, result.exitCode);

      const entry: HistoryEntry = {
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        taskType,
        prompt: executionDescription,
        result,
        status: task.status,
        startedAt,
        finishedAt,
        changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
        codeChanges: codeChanges || undefined,
        verification,
        artifacts,
        failurePolicy: task.failurePolicy,
        ownerNote: task.ownerNote,
        runId: this._currentRunId || undefined,
        modelId: (task as Task & { _modelId?: string })._modelId,
        modelReason: (task as Task & { _modelReason?: string })._modelReason,
      };
      this.historyStore.add(entry);

      if (task.status === TaskStatus.Completed) {
        this.emit('task-completed', task, result);
      } else {
        this.emit('task-failed', task, result);
        this.applyFailurePolicy(task, result);
      }
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const errMsg = err instanceof Error ? err.message : String(err);
      const guidance = taskType === 'agent' ? this.getErrorGuidance(errMsg, engineId) : null;
      const errorResult: EngineResult = {
        stdout: '',
        stderr: guidance ? `${errMsg}\n\n${guidance}` : errMsg,
        exitCode: 1,
        durationMs: 0,
        summary: 'Execution failed before completing.',
        command: task.command,
      };

      task.status = this.resolveFinalStatus(task, errorResult.exitCode);
      this.historyStore.add({
        id: generateId(),
        taskId: task.id,
        taskName: task.name,
        playlistId: playlist.id,
        playlistName: playlist.name,
        engine: engineId,
        taskType,
        prompt: executionDescription,
        result: errorResult,
        status: task.status,
        startedAt,
        finishedAt,
        failurePolicy: task.failurePolicy,
        ownerNote: task.ownerNote,
        runId: this._currentRunId || undefined,
      });

      this.emit('task-failed', task, errorResult);
      this.applyFailurePolicy(task, errorResult);
    } finally {
      clearTimeout(timeoutId);
      this._abortController?.signal.removeEventListener('abort', onParentAbort);
    }
  }

  private getTaskType(task: Task): TaskType {
    return task.type ?? 'agent';
  }

  private resolveFailurePolicy(task: Task): FailurePolicy {
    return task.failurePolicy ?? 'continue';
  }

  private resolveFinalStatus(task: Task, exitCode: number): TaskStatus {
    if (exitCode === 0) {
      return TaskStatus.Completed;
    }
    return this.resolveFailurePolicy(task) === 'mark-blocked'
      ? TaskStatus.Blocked
      : TaskStatus.Failed;
  }

  private applyFailurePolicy(task: Task, result: EngineResult): void {
    if (this.resolveFailurePolicy(task) === 'stop') {
      this.emit('task-output', task, `\n[Failure policy] Stopping after "${task.name}" failed (exit ${result.exitCode}).\n`, 'stderr');
      this.stop();
    }
  }

  private async runTaskByType(
    taskType: TaskType,
    task: Task,
    engineId: EngineId,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
  ): Promise<EngineResult> {
    switch (taskType) {
      case 'agent':
        return this.runAgentTask(task, engineId, cwd, fullPrompt, signal);
      case 'command':
        return this.runCommandTask(task, cwd, signal);
      case 'service':
        return this.runServiceTask(task, cwd, signal);
      case 'check':
        return this.runCheckTask(task, cwd, signal);
      default:
        return { stdout: '', stderr: `Unsupported task type "${taskType}"`, exitCode: 1, durationMs: 0 };
    }
  }

  private async runAgentTask(
    task: Task,
    engineId: EngineId,
    cwd: string,
    fullPrompt: string,
    signal: AbortSignal,
  ): Promise<EngineResult> {
    // Auto-model selection
    const preset = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<ReasoningPreset>('defaultReasoningPreset', 'auto');
    const autoSelect = vscode.workspace.getConfiguration('agentTaskPlayer')
      .get<boolean>('autoModelSelection', true);
    const selection = autoSelect ? selectModel(task, engineId, preset) : null;

    // Store selection for history entry
    (task as Task & { _modelId?: string; _modelReason?: string })._modelId = selection?.modelId;
    (task as Task & { _modelId?: string; _modelReason?: string })._modelReason = selection?.reason;

    const engine = getEngine(engineId);
    return engine.runTask({
      prompt: fullPrompt,
      cwd,
      files: task.files,
      signal,
      modelId: selection?.modelId,
      onOutput: (chunk, stream) => {
        this.emit('task-output', task, chunk, stream);
      },
    });
  }

  private async runCommandTask(task: Task, cwd: string, signal: AbortSignal): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Command task is missing the "command" field.', exitCode: 1, durationMs: 0 };
    }
    this.emit('task-output', task, `\n-- Command: ${command} --\n`, 'stdout');
    const result = await this.runLocalCommand(command, {
      cwd,
      env: task.env,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });
    return { ...result, summary: result.exitCode === 0 ? 'Command completed successfully.' : 'Command exited with an error.' };
  }

  private async runCheckTask(task: Task, cwd: string, signal: AbortSignal): Promise<EngineResult> {
    const command = task.command?.trim() || task.verifyCommand?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Check task requires "command" or "verifyCommand".', exitCode: 1, durationMs: 0 };
    }
    this.emit('task-output', task, `\n-- Check: ${command} --\n`, 'stdout');
    const result = await this.runLocalCommand(command, {
      cwd,
      env: task.env,
      signal,
      onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
    });
    return { ...result, summary: result.exitCode === 0 ? 'Check passed.' : 'Check failed.' };
  }

  private async runServiceTask(task: Task, cwd: string, signal: AbortSignal): Promise<EngineResult> {
    const command = task.command?.trim();
    if (!command) {
      return { stdout: '', stderr: 'Service task is missing the "command" field.', exitCode: 1, durationMs: 0 };
    }

    const startedAt = Date.now();
    const serviceTimeoutMs = task.startupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS;

    return new Promise<EngineResult>((resolve) => {
      const proc = spawn(command, [], {
        cwd,
        shell: true,
        env: { ...process.env, ...(task.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: EngineResult, keepProcess = false) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(readinessInterval);
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        proc.stdout?.removeListener('data', onStdout);
        proc.stderr?.removeListener('data', onStderr);
        proc.removeListener('error', onError);
        proc.removeListener('close', onCloseBeforeReady);

        if (keepProcess) {
          this._serviceProcesses.set(task.id, {
            taskId: task.id,
            taskName: task.name,
            command,
            cwd,
            startedAt: new Date().toISOString(),
            port: task.port,
            healthCheckUrl: task.healthCheckUrl,
            readyPattern: task.readyPattern,
            proc,
          });
          proc.once('close', () => {
            this._serviceProcesses.delete(task.id);
          });
        } else {
          this.killProcess(proc);
        }

        resolve(result);
      };

      const onStdout = (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.emit('task-output', task, text, 'stdout');
      };

      const onStderr = (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.emit('task-output', task, text, 'stderr');
      };

      const onError = (err: Error) => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + err.message,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service failed to start.',
        });
      };

      const onCloseBeforeReady = (code: number | null, procSignal: NodeJS.Signals | null) => {
        finish({
          stdout,
          stderr: stderr || `Service exited before becoming ready (${code ?? procSignal ?? 'unknown'}).`,
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service exited before becoming ready.',
        });
      };

      const onAbort = () => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + '[Service start aborted]',
          exitCode: 130,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service start aborted.',
        });
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.once('error', onError);
      proc.once('close', onCloseBeforeReady);
      signal.addEventListener('abort', onAbort, { once: true });

      this.emit('task-output', task, `\n-- Service: ${command} --\n`, 'stdout');

      const readinessInterval = setInterval(async () => {
        if (settled) {
          return;
        }
        const ready = await this.isServiceReady(task, stdout + '\n' + stderr, Date.now() - startedAt);
        if (!ready) {
          return;
        }
        this.emit('task-output', task, '\n[Service] Ready\n', 'stdout');
        finish({
          stdout,
          stderr,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          command,
          summary: this.describeServiceReady(task),
        }, true);
      }, 400);

      const timeoutId = setTimeout(() => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + `[Service readiness timed out after ${Math.round(serviceTimeoutMs / 1000)}s]`,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
          summary: 'Service did not become ready in time.',
        });
      }, serviceTimeoutMs);
    });
  }

  private async isServiceReady(task: Task, output: string, elapsedMs: number): Promise<boolean> {
    const checks: boolean[] = [];

    if (task.readyPattern) {
      checks.push(this.matchesReadyPattern(output, task.readyPattern));
    }

    if (task.port) {
      checks.push(await this.checkPort(task.port));
    }

    if (task.healthCheckUrl) {
      checks.push(await this.checkHealthUrl(task.healthCheckUrl));
    }

    if (checks.length === 0) {
      return elapsedMs >= 1500;
    }

    return checks.every(Boolean);
  }

  private describeServiceReady(task: Task): string {
    const parts: string[] = ['Service is running'];
    if (task.port) {
      parts.push(`port ${task.port} is open`);
    }
    if (task.healthCheckUrl) {
      parts.push(`health check passed at ${task.healthCheckUrl}`);
    }
    if (task.readyPattern) {
      parts.push(`ready pattern "${task.readyPattern}" matched`);
    }
    return parts.join('; ') + '.';
  }

  private matchesReadyPattern(output: string, pattern: string): boolean {
    try {
      return new RegExp(pattern, 'm').test(output);
    } catch {
      return output.includes(pattern);
    }
  }

  private checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(750);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  private checkHealthUrl(urlString: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = urlString.startsWith('https://') ? https : http;
      const req = client.get(urlString, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 400);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }

  private async runVerification(
    command: string,
    cwd: string,
    env: Record<string, string> | undefined,
    parentSignal: AbortSignal,
    task: Task,
  ): Promise<VerificationResult> {
    const verifyAbort = new AbortController();
    const timer = setTimeout(() => verifyAbort.abort(), VERIFY_TIMEOUT_MS);
    const onParentAbort = () => verifyAbort.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const result = await this.runLocalCommand(command, {
        cwd,
        env,
        signal: verifyAbort.signal,
        onOutput: (chunk, stream) => this.emit('task-output', task, chunk, stream),
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      return {
        command,
        exitCode: result.exitCode,
        output,
        durationMs: result.durationMs,
        passed: result.exitCode === 0,
      };
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  private runLocalCommand(command: string, options: CommandRunOptions): Promise<EngineResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let settled = false;

      const proc = spawn(command, [], {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (result: EngineResult) => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = () => {
        this.killProcess(proc);
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + '[Command aborted]',
          exitCode: 130,
          durationMs: Date.now() - startedAt,
          command,
        });
      };

      options.signal.addEventListener('abort', onAbort, { once: true });

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        options.onOutput?.(text, 'stdout');
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onOutput?.(text, 'stderr');
      });

      proc.on('error', (err: Error) => {
        finish({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + err.message,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          command,
        });
      });

      proc.on('close', (code) => {
        finish({
          stdout,
          stderr,
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
          command,
        });
      });
    });
  }

  private killProcess(proc: ChildProcess): void {
    if (proc.killed) {
      return;
    }
    if (process.platform === 'win32' && proc.pid) {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private buildPrompt(task: Task, cwd: string, plan: Plan, playlist: Playlist): string {
    const settings = getContextSettings();
    let prompt = '';
    if (settings.enabled) {
      const ctx = buildContext({ plan, playlist, task, cwd, historyStore: this.historyStore, settings });
      if (ctx) {
        prompt += ctx + '\n\n';
      }
    }
    prompt += task.prompt;

    const contract = this.buildTaskContract(task);
    if (contract) {
      prompt += `\n\nExecution contract:\n${contract}`;
    }

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

  private buildTaskDescription(task: Task): string {
    const lines = [
      task.prompt ? `Task: ${task.prompt}` : `Task: ${task.name}`,
      this.buildTaskContract(task),
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  private buildTaskContract(task: Task): string {
    const sections: string[] = [];

    if (task.command) {
      sections.push(`- Command: ${task.command}`);
    }
    if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
      sections.push(`- Acceptance criteria:\n${task.acceptanceCriteria.map(item => `  - ${item}`).join('\n')}`);
    }
    if (task.verifyCommand) {
      sections.push(`- Verify command: ${task.verifyCommand}`);
    }
    if (task.expectedArtifacts && task.expectedArtifacts.length > 0) {
      sections.push(`- Expected artifacts:\n${task.expectedArtifacts.map(item => `  - ${item}`).join('\n')}`);
    }
    if (task.ownerNote) {
      sections.push(`- Owner note: ${task.ownerNote}`);
    }
    if (task.failurePolicy) {
      sections.push(`- Failure policy: ${task.failurePolicy}`);
    }
    if (task.port) {
      sections.push(`- Port check: ${task.port}`);
    }
    if (task.healthCheckUrl) {
      sections.push(`- Health check: ${task.healthCheckUrl}`);
    }
    if (task.readyPattern) {
      sections.push(`- Ready pattern: ${task.readyPattern}`);
    }

    return sections.join('\n');
  }

  private resolveCwd(taskCwd?: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (!taskCwd) {
      return root;
    }
    return path.isAbsolute(taskCwd) ? taskCwd : path.join(root, taskCwd);
  }

  private captureArtifacts(expectedArtifacts: string[], cwd: string): TaskArtifact[] {
    return expectedArtifacts.map((target) => {
      const resolvedPath = path.isAbsolute(target) ? target : path.join(cwd, target);
      return {
        target,
        exists: fs.existsSync(resolvedPath),
        resolvedPath,
      };
    });
  }

  private buildResultSummary(
    task: Task,
    result: EngineResult,
    verification?: VerificationResult,
    artifacts?: TaskArtifact[],
  ): string {
    const parts: string[] = [];
    parts.push(result.exitCode === 0 ? `${this.getTaskType(task)} task passed` : `${this.getTaskType(task)} task failed with exit ${result.exitCode}`);
    if (verification) {
      parts.push(verification.passed ? 'verification passed' : 'verification failed');
    }
    if (artifacts && artifacts.length > 0) {
      const found = artifacts.filter(artifact => artifact.exists).length;
      parts.push(`artifacts ${found}/${artifacts.length} present`);
    }
    if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
      parts.push(`${task.acceptanceCriteria.length} acceptance criteria documented`);
    }
    return parts.join('; ') + '.';
  }

  private getErrorGuidance(errorMsg: string, engineId: EngineId): string | null {
    const lower = errorMsg.toLowerCase();

    if (lower.includes('enoent') || lower.includes('not found') || lower.includes('not recognized')) {
      return `Hint: The "${engineId}" CLI does not appear to be installed or is not in your PATH. Check the command in Settings > agentTaskPlayer.engines.${engineId}.command`;
    }
    if (lower.includes('eacces') || lower.includes('permission denied')) {
      return `Hint: Permission denied. Ensure the "${engineId}" CLI binary is executable.`;
    }
    if (lower.includes('timeout') || lower.includes('etimedout')) {
      return `Hint: The task timed out. The AI engine may be overloaded - try again or use a different engine.`;
    }
    if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication')) {
      return `Hint: Authentication failed. Ensure your API key or credentials for "${engineId}" are configured correctly.`;
    }
    if (lower.includes('rate limit') || lower.includes('429')) {
      return `Hint: Rate limited by the "${engineId}" API. Wait a moment and try again.`;
    }
    return null;
  }

  private runGitCommand(args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.killProcess(proc);
          resolve(null);
        }
      }, GIT_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      proc.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : null);
        }
      });
    });
  }

  private async captureGitRef(cwd: string): Promise<string | null> {
    const stashRef = await this.runGitCommand(['stash', 'create'], cwd);
    if (stashRef) {
      return stashRef;
    }
    return this.runGitCommand(['rev-parse', 'HEAD'], cwd);
  }

  private async captureGitDiff(ref: string | null, cwd: string): Promise<{ changedFiles: string[]; codeChanges: string }> {
    if (!ref) {
      return { changedFiles: [], codeChanges: '' };
    }
    const nameOnly = await this.runGitCommand(['diff', '--name-only', ref], cwd);
    const diff = await this.runGitCommand(['diff', '--no-color', ref], cwd);
    const changedFiles = nameOnly ? nameOnly.split('\n').filter(f => f.length > 0) : [];
    return { changedFiles, codeChanges: diff || '' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isStopping(): boolean {
    return this._state === RunnerState.Stopping;
  }
}
