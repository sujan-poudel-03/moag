// ─── Engine adapter interface and registry ───

import { EngineId, EngineResult } from '../models/types';
import { OutputCallback } from './base-cli';
import { commandExists } from '../utils/command-exists';
import { costLedger } from '../utils/cost-ledger';

/** Options passed to every engine adapter */
export interface EngineRunOptions {
  /** The task prompt / instruction */
  prompt: string;
  /** Working directory for the CLI process */
  cwd: string;
  /** Files to reference as context */
  files?: string[];
  /** AbortSignal to cancel the running process */
  signal?: AbortSignal;
  /** Callback for streaming output chunks */
  onOutput?: OutputCallback;
  /** Model override for auto-model selection (e.g., "claude-sonnet-4") */
  modelId?: string;
  /**
   * Multi-turn session key — adapters that support conversation history
   * (e.g. AnthropicAdapter) group turns by this ID so consecutive tasks
   * in the same playlist share context.
   */
  sessionId?: string;
  /** Enable browser tools (take_screenshot, run_playwright_test) for visual-test tasks */
  browserEnabled?: boolean;
  /** URL of the running sandbox — injected for visual-test tasks */
  sandboxUrl?: string;
  /** Attribution label for cost accounting. Defaults to 'unattributed'. */
  costLabel?: string;
}

/** Every engine adapter implements this interface */
export interface EngineAdapter {
  readonly id: EngineId;
  readonly displayName: string;
  /** Returns the CLI command this adapter will invoke */
  getCommand(): string;
  runTask(options: EngineRunOptions): Promise<EngineResult>;
}

// ─── Cost ceiling guard ──────────────────────────────────────────────────────

/**
 * Consulted before every engine call. Returning false blocks the call.
 *
 * MUST be synchronous and cheap — a plain latch read. Anything that awaits or
 * shows UI would fire once per concurrent call under parallelPlaylists.
 */
export type CeilingGuard = (ctx: { engineId: EngineId; label: string }) => boolean;

let ceilingGuard: CeilingGuard | null = null;

/** Install (or clear, with null) the process-wide cost ceiling guard. */
export function setCeilingGuard(guard: CeilingGuard | null): void {
  ceilingGuard = guard;
}

/** Unset guard = allow. A guard that throws is treated as allow, never as block. */
function isAllowedByCeiling(engineId: EngineId, label: string): boolean {
  if (!ceilingGuard) {
    return true;
  }
  try {
    return ceilingGuard({ engineId, label });
  } catch {
    // A broken guard must not brick every engine call in the process.
    return true;
  }
}

/** Message surfaced on a blocked call — a synthetic failure, never a throw. */
const CEILING_BLOCKED_MESSAGE =
  'Cost ceiling reached — raise agentTaskPlayer.costBudgetUsd, or run the '
  + '"MOAG: Reset Spend Counter" command to clear the block.';

// ─── Cost accounting wrapper ─────────────────────────────────────────────────

/** Marks an adapter instance as already wrapped, so wrapping is idempotent. */
const WRAPPED = Symbol('moag.costAccounted');

/**
 * Wrap an adapter so every runTask() result is reported to the cost ledger.
 *
 * The registry stores wrapped adapters, which makes accounting impossible to
 * bypass for anything reached through getEngine()/getAllEngines(). Wrapping is
 * idempotent — re-wrapping an already-wrapped adapter returns it unchanged, so
 * a re-registration cannot double-count.
 */
export function withCostAccounting(adapter: EngineAdapter): EngineAdapter {
  if ((adapter as unknown as Record<symbol, boolean>)[WRAPPED]) {
    return adapter;
  }

  const wrapped: EngineAdapter = {
    id: adapter.id,
    displayName: adapter.displayName,
    getCommand: () => adapter.getCommand(),
    async runTask(options: EngineRunOptions): Promise<EngineResult> {
      const label = options.costLabel ?? 'unattributed';
      if (!isAllowedByCeiling(adapter.id, label)) {
        // Blocked: the engine is never invoked and nothing is recorded.
        return { stdout: '', stderr: CEILING_BLOCKED_MESSAGE, exitCode: 1, durationMs: 0 };
      }

      // KNOWN BLIND SPOT: a rejection (abort, timeout kill, spawn failure)
      // records nothing, because there is no EngineResult to read tokenUsage
      // from. Tokens spent before the failure stay invisible to the ceiling,
      // so the ledger under-counts on exactly the runs that cost the most.
      const result = await adapter.runTask(options);
      // Recorded even on a non-zero exit — a failed task still burned tokens.
      costLedger.record(result.tokenUsage, {
        engineId: adapter.id,
        label: options.costLabel,
      });
      return result;
    },
  };

  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false });
  return wrapped;
}

/** Global registry of engine adapters */
const registry = new Map<EngineId, EngineAdapter>();

export function registerEngine(adapter: EngineAdapter): void {
  registry.set(adapter.id, withCostAccounting(adapter));
}

export function getEngine(id: EngineId): EngineAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`No engine adapter registered for "${id}"`);
  }
  return adapter;
}

export function getAllEngines(): EngineAdapter[] {
  return Array.from(registry.values());
}

/** Result of an engine availability check */
export interface EngineAvailability {
  available: boolean;
  command: string;
  displayName: string;
  /** Version string if the engine responded to --version / --help */
  version?: string;
}

/**
 * Probe a command with --version (or --help fallback) and return the first line of output.
 * Returns null if the command is not found or times out (5s).
 */
async function probeVersion(command: string): Promise<string | null> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    execFile(command, ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) {
        // Some CLIs only respond to --help
        resolve(null);
        return;
      }
      const output = (stdout || stderr || '').trim();
      const firstLine = output.split('\n')[0]?.trim() || null;
      resolve(firstLine);
    });
  });
}

/**
 * Check availability of multiple engines in parallel.
 * Returns a Map from EngineId to availability info.
 * First checks PATH existence, then probes --version for available engines.
 */
export async function checkEngineAvailability(
  engineIds: EngineId[]
): Promise<Map<EngineId, EngineAvailability>> {
  const unique = [...new Set(engineIds)];
  const results = new Map<EngineId, EngineAvailability>();

  await Promise.all(
    unique.map(async (id) => {
      const adapter = registry.get(id);
      if (!adapter) {
        results.set(id, { available: false, command: '', displayName: id });
        return;
      }
      const command = adapter.getCommand();
      const exists = await commandExists(command);
      if (!exists) {
        results.set(id, { available: false, command, displayName: adapter.displayName });
        return;
      }
      // Probe --version to verify the command actually works
      const version = await probeVersion(command);
      results.set(id, {
        available: true,
        command,
        displayName: adapter.displayName,
        version: version || undefined,
      });
    })
  );

  return results;
}
