// ─── Desktop validation adapter (Electron / WinAppDriver / platform UI tests) ───

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationAdapter,
  ValidationResult,
  ValidationRunOptions,
  ValidationStageResult,
} from './types';

type DesktopTool = 'electron-playwright' | 'spectron' | 'winappdriver' | 'generic';

export class DesktopValidator implements ValidationAdapter {
  readonly target = 'desktop' as const;

  private detectTool(cwd: string): DesktopTool | null {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (allDeps['electron'] && (allDeps['@playwright/test'] || allDeps['playwright'])) {
        return 'electron-playwright';
      }
      if (allDeps['spectron']) {
        return 'spectron';
      }
      if (allDeps['electron']) {
        // Electron app without explicit UI test tooling → generic npm test
        return 'generic';
      }

      // WinAppDriver: look for a marker file
      if (
        fs.existsSync(path.join(cwd, 'winappdriver.json')) ||
        fs.existsSync(path.join(cwd, 'WinAppDriver')) ||
        allDeps['winappdriver']
      ) {
        return 'winappdriver';
      }
    } catch {
      // no package.json or invalid JSON
    }

    return null;
  }

  async isAvailable(cwd: string): Promise<boolean> {
    return this.detectTool(cwd) !== null;
  }

  async unavailableReason(cwd: string): Promise<string> {
    return [
      `No Electron, WinAppDriver, or desktop UI test tooling found in "${cwd}".`,
      `To enable desktop validation, add one of:`,
      `  - Electron + @playwright/test (electron-playwright)`,
      `  - spectron (legacy Electron testing)`,
      `  - winappdriver (Windows native app testing)`,
    ].join('\n');
  }

  async run(opts: ValidationRunOptions): Promise<ValidationResult> {
    const { cwd, profile, signal, onOutput, env } = opts;
    const tool = this.detectTool(cwd);

    if (!tool) {
      return this.skippedResult(await this.unavailableReason(cwd));
    }

    const stages: ValidationStageResult[] = [];
    const startedAt = Date.now();

    // Always run unit tests
    stages.push(await this.runStage('unit', this.unitCommand(cwd), cwd, env, signal, onOutput));

    // UI (e2e) tests only for pr and full profiles
    if ((profile === 'pr' || profile === 'full') && !signal.aborted) {
      const uiCommand = this.uiCommand(cwd, tool);
      stages.push(await this.runStage('e2e', uiCommand, cwd, env, signal, onOutput));
    }

    return this.buildResult(stages, startedAt);
  }

  private unitCommand(cwd: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.['test:unit']) { return 'npm run test:unit'; }
      if (pkg.scripts?.test) { return 'npm test'; }
    } catch {
      // ignore
    }
    return 'npm test';
  }

  private uiCommand(cwd: string, tool: DesktopTool): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.['test:ui']) { return 'npm run test:ui'; }
      if (pkg.scripts?.['test:e2e']) { return 'npm run test:e2e'; }
    } catch {
      // ignore
    }
    switch (tool) {
      case 'electron-playwright': return 'npx playwright test --project=electron';
      case 'spectron': return 'npm run test:spectron';
      case 'winappdriver': return 'npm run test:winappdriver';
      default: return 'npm run test:e2e';
    }
  }

  private async runStage(
    stage: ValidationStageResult['stage'],
    command: string,
    cwd: string,
    env: Record<string, string> | undefined,
    signal: AbortSignal,
    onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ValidationStageResult> {
    const startedAt = Date.now();
    let output = '';

    onOutput(`\n[desktop:${stage}] Running: ${command}\n`, 'stdout');

    const result = await runCommand(command, { cwd, env, signal }, (chunk, stream) => {
      output += chunk;
      onOutput(chunk, stream);
    });

    return {
      stage,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      output,
      passed: result.exitCode === 0,
    };
  }

  private buildResult(stages: ValidationStageResult[], startedAt: number): ValidationResult {
    const passed = stages.every(s => s.passed);
    const failedStages = stages.filter(s => !s.passed);

    return {
      target: 'desktop',
      available: true,
      stages,
      exitCode: passed ? 0 : 1,
      durationMs: Date.now() - startedAt,
      output: stages.map(s => s.output).join('\n'),
      summary: passed
        ? `${stages.length} stage${stages.length === 1 ? '' : 's'} passed`
        : `${failedStages.length} stage${failedStages.length === 1 ? '' : 's'} failed`,
    };
  }

  private skippedResult(reason: string): ValidationResult {
    return {
      target: 'desktop',
      available: false,
      skipReason: reason,
      stages: [],
      exitCode: 0,
      durationMs: 0,
      output: '',
      summary: 'skipped',
    };
  }
}

function runCommand(
  command: string,
  opts: { cwd: string; env?: Record<string, string>; signal: AbortSignal },
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (code: number) => {
      if (settled) { return; }
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code });
    };

    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      finish(130);
    };

    opts.signal.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', (buf: Buffer) => onOutput(buf.toString(), 'stdout'));
    proc.stderr?.on('data', (buf: Buffer) => onOutput(buf.toString(), 'stderr'));
    proc.on('error', () => finish(1));
    proc.on('close', (code) => finish(code ?? 1));
  });
}
