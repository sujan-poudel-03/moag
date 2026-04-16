// ─── Validation adapter contracts ───

import { EngineResult } from '../../models/types';

/** Target platform for validation */
export type ValidationTarget = 'web' | 'mobile' | 'desktop';

/** A single stage run within a validation target */
export interface ValidationStageResult {
  stage: 'lint' | 'unit' | 'integration' | 'e2e';
  exitCode: number;
  durationMs: number;
  output: string;
  /** Path to screenshots captured during this stage, if any */
  screenshots?: string[];
  /** Path to trace files (e.g. Playwright traces), if any */
  traces?: string[];
  /** Path to log files, if any */
  logs?: string[];
  passed: boolean;
}

/** Aggregate result from a validation adapter */
export interface ValidationResult {
  target: ValidationTarget;
  /** Whether the adapter was available (false = skipped, not failed) */
  available: boolean;
  /** Human-readable reason for skipping when available=false */
  skipReason?: string;
  stages: ValidationStageResult[];
  /** Combined exit code (0 = all stages passed) */
  exitCode: number;
  durationMs: number;
  /** Collapsed stdout+stderr for history entry */
  output: string;
  /** One-line summary for the dashboard pill */
  summary: string;
  /** Number of flaky detections (stages that passed on retry) */
  flakyCount?: number;
}

/** Options passed to each adapter's run() */
export interface ValidationRunOptions {
  /** Working directory */
  cwd: string;
  /** Profile determines which stages to run */
  profile: 'quick' | 'pr' | 'full';
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Streaming output callback */
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Environment overrides */
  env?: Record<string, string>;
}

/** Contract all target adapters must satisfy */
export interface ValidationAdapter {
  readonly target: ValidationTarget;
  /**
   * Returns true when the required tooling is available on this machine.
   * When false the adapter is skipped rather than failed.
   */
  isAvailable(cwd: string): Promise<boolean>;
  /** Reason returned when isAvailable is false */
  unavailableReason(cwd: string): Promise<string>;
  /** Run the validation stages and return an aggregate result */
  run(opts: ValidationRunOptions): Promise<ValidationResult>;
}

/** Convert ValidationResult to a plain EngineResult for the runner */
export function validationResultToEngineResult(results: ValidationResult[]): EngineResult {
  const combined = results
    .map(r => {
      if (!r.available) {
        return `[${r.target}] SKIPPED — ${r.skipReason ?? 'unavailable'}`;
      }
      const stageLines = r.stages
        .map(s => `  [${s.stage}] ${s.passed ? 'PASS' : 'FAIL'} (${s.durationMs}ms)`)
        .join('\n');
      return `[${r.target}] ${r.summary}\n${stageLines}\n${r.output}`.trim();
    })
    .join('\n\n');

  const allPassed = results.every(r => !r.available || r.exitCode === 0);
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    stdout: allPassed ? combined : '',
    stderr: allPassed ? '' : combined,
    exitCode: allPassed ? 0 : 1,
    durationMs: totalMs,
    summary: results
      .map(r => (r.available ? `${r.target}: ${r.summary}` : `${r.target}: skipped`))
      .join(' | '),
  };
}
