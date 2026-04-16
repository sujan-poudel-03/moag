// ─── Web validation adapter (Playwright / Cypress) ───

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationAdapter,
  ValidationResult,
  ValidationRunOptions,
  ValidationStageResult,
} from './types';

/** Commands probed to detect web test tooling */
const PLAYWRIGHT_MARKERS = ['playwright.config.ts', 'playwright.config.js'];
const CYPRESS_MARKERS = ['cypress.config.ts', 'cypress.config.js', 'cypress.json'];

export class WebValidator implements ValidationAdapter {
  readonly target = 'web' as const;

  private detectTool(cwd: string): 'playwright' | 'cypress' | null {
    for (const marker of PLAYWRIGHT_MARKERS) {
      if (fs.existsSync(path.join(cwd, marker))) {
        return 'playwright';
      }
    }
    for (const marker of CYPRESS_MARKERS) {
      if (fs.existsSync(path.join(cwd, marker))) {
        return 'cypress';
      }
    }
    // Fall back to package.json dependency check
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['@playwright/test'] || allDeps['playwright']) {
        return 'playwright';
      }
      if (allDeps['cypress']) {
        return 'cypress';
      }
    } catch {
      // no package.json
    }
    return null;
  }

  async isAvailable(cwd: string): Promise<boolean> {
    return this.detectTool(cwd) !== null;
  }

  async unavailableReason(cwd: string): Promise<string> {
    return `No Playwright or Cypress config found in "${cwd}". Add a playwright.config.ts or cypress.config.ts to enable web validation.`;
  }

  async run(opts: ValidationRunOptions): Promise<ValidationResult> {
    const { cwd, profile, signal, onOutput, env } = opts;
    const tool = this.detectTool(cwd);

    if (!tool) {
      return this.skippedResult(await this.unavailableReason(cwd));
    }

    const stages: ValidationStageResult[] = [];
    const startedAt = Date.now();

    // Quick: lint + unit only; pr: + integration; full: all including e2e
    const runLint = true;
    const runUnit = true;
    const runIntegration = profile !== 'quick';
    const runE2e = profile === 'full' || profile === 'pr';

    if (runLint) {
      stages.push(await this.runStage('lint', this.lintCommand(cwd), cwd, env, signal, onOutput));
      if (stages[stages.length - 1].exitCode !== 0 && profile === 'quick') {
        return this.buildResult(stages, startedAt, 'Lint failed (quick profile stops here)');
      }
    }

    if (runUnit) {
      stages.push(await this.runStage('unit', this.unitCommand(cwd), cwd, env, signal, onOutput));
    }

    if (runIntegration) {
      stages.push(await this.runStage('integration', this.integrationCommand(cwd), cwd, env, signal, onOutput));
    }

    if (runE2e && !signal.aborted) {
      const e2eCmd = tool === 'playwright'
        ? 'npx playwright test'
        : 'npx cypress run';
      stages.push(await this.runStage('e2e', e2eCmd, cwd, env, signal, onOutput));
    }

    return this.buildResult(stages, startedAt);
  }

  private lintCommand(cwd: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.lint) { return 'npm run lint'; }
      if (pkg.scripts?.['lint:ci']) { return 'npm run lint:ci'; }
    } catch {
      // ignore
    }
    return 'npx eslint . --max-warnings 0';
  }

  private unitCommand(cwd: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['vitest']) { return 'npx vitest run'; }
      if (allDeps['jest'] || allDeps['ts-jest']) { return 'npx jest --passWithNoTests'; }
      if (pkg.scripts?.test) { return 'npm test'; }
    } catch {
      // ignore
    }
    return 'npm test';
  }

  private integrationCommand(cwd: string): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.['test:integration']) { return 'npm run test:integration'; }
      if (pkg.scripts?.['test:int']) { return 'npm run test:int'; }
    } catch {
      // ignore
    }
    return 'npm run test:integration';
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

    onOutput(`\n[web:${stage}] Running: ${command}\n`, 'stdout');

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

  private buildResult(
    stages: ValidationStageResult[],
    startedAt: number,
    overrideSummary?: string,
  ): ValidationResult {
    const totalMs = Date.now() - startedAt;
    const passed = stages.every(s => s.passed);
    const failedStages = stages.filter(s => !s.passed);

    return {
      target: 'web',
      available: true,
      stages,
      exitCode: passed ? 0 : 1,
      durationMs: totalMs,
      output: stages.map(s => s.output).join('\n'),
      summary: overrideSummary
        ?? (passed
          ? `${stages.length} stage${stages.length === 1 ? '' : 's'} passed`
          : `${failedStages.length} stage${failedStages.length === 1 ? '' : 's'} failed`),
    };
  }

  private skippedResult(reason: string): ValidationResult {
    return {
      target: 'web',
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

// ─── Shared command runner ───

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
