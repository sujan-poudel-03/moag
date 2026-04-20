// ─── Mobile validation adapter (Android emulator / iOS simulator / Appium) ───

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationAdapter,
  ValidationResult,
  ValidationRunOptions,
  ValidationStageResult,
} from './types';
import { resolveValidationProfile } from '../../models/execution-profiles';

type MobileTool = 'detox' | 'appium' | 'expo';

export class MobileValidator implements ValidationAdapter {
  readonly target = 'mobile' as const;

  private detectTool(cwd: string): MobileTool | null {
    // Detox: look for .detoxrc or detox key in package.json
    if (
      fs.existsSync(path.join(cwd, '.detoxrc.js')) ||
      fs.existsSync(path.join(cwd, '.detoxrc.json')) ||
      fs.existsSync(path.join(cwd, '.detoxrc.ts'))
    ) {
      return 'detox';
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['detox']) { return 'detox'; }
      if (allDeps['appium'] || allDeps['webdriverio']) { return 'appium'; }
      if (allDeps['expo']) { return 'expo'; }
    } catch {
      // no package.json
    }

    return null;
  }

  private isDeviceAvailable(): boolean {
    // Check for connected Android devices or running iOS simulators
    try {
      const adbOutput = execSync('adb devices', { stdio: 'pipe', timeout: 5000 }).toString();
      const devices = adbOutput.split('\n').filter(l => l.includes('\tdevice'));
      if (devices.length > 0) { return true; }
    } catch {
      // adb not installed or failed
    }
    try {
      const xcrunOutput = execSync('xcrun simctl list devices --json', { stdio: 'pipe', timeout: 5000 }).toString();
      const parsed = JSON.parse(xcrunOutput);
      const devices: unknown[] = Object.values(parsed.devices ?? {}).flat() as unknown[];
      if (devices.some((d: unknown) => (d as { state: string }).state === 'Booted')) { return true; }
    } catch {
      // xcrun not available (non-macOS)
    }
    return false;
  }

  async isAvailable(cwd: string): Promise<boolean> {
    const tool = this.detectTool(cwd);
    if (!tool) { return false; }
    return this.isDeviceAvailable();
  }

  async unavailableReason(cwd: string): Promise<string> {
    const tool = this.detectTool(cwd);
    if (!tool) {
      return `No Detox, Appium, or Expo test config found in "${cwd}". Add detox or appium to your devDependencies to enable mobile validation.`;
    }
    return `Mobile validation requires a connected Android device (adb) or a booted iOS simulator (xcrun simctl). Start an emulator/simulator and retry.`;
  }

  async run(opts: ValidationRunOptions): Promise<ValidationResult> {
    const { cwd, profile, signal, onOutput, env } = opts;
    const tool = this.detectTool(cwd);

    if (!tool || !this.isDeviceAvailable()) {
      return this.skippedResult(await this.unavailableReason(cwd));
    }

    const stages: ValidationStageResult[] = [];
    const startedAt = Date.now();

    const { stages: enabledStages } = resolveValidationProfile(profile);

    if (enabledStages.includes('unit')) {
      stages.push(await this.runStage('unit', this.unitCommand(cwd, tool), cwd, env, signal, onOutput));
    }

    if (enabledStages.includes('e2e') && !signal.aborted) {
      stages.push(await this.runStage('e2e', this.e2eCommand(cwd, tool), cwd, env, signal, onOutput));
    }

    return this.buildResult(stages, startedAt);
  }

  private unitCommand(cwd: string, tool: MobileTool): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.['test:unit']) { return 'npm run test:unit'; }
      if (pkg.scripts?.test) { return 'npm test'; }
    } catch {
      // ignore
    }
    return tool === 'expo' ? 'npx jest --passWithNoTests' : 'npm test';
  }

  private e2eCommand(_cwd: string, tool: MobileTool): string {
    switch (tool) {
      case 'detox': return 'npx detox test --configuration release';
      case 'appium': return 'npm run test:e2e';
      case 'expo': return 'npx expo run:android --no-install && npx jest e2e';
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

    onOutput(`\n[mobile:${stage}] Running: ${command}\n`, 'stdout');

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
      target: 'mobile',
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
      target: 'mobile',
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
