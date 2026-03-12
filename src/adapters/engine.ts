// ─── Engine adapter interface and registry ───

import { EngineId, EngineResult } from '../models/types';
import { OutputCallback } from './base-cli';
import { commandExists } from '../utils/command-exists';

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
}

/** Every engine adapter implements this interface */
export interface EngineAdapter {
  readonly id: EngineId;
  readonly displayName: string;
  /** Returns the CLI command this adapter will invoke */
  getCommand(): string;
  runTask(options: EngineRunOptions): Promise<EngineResult>;
}

/** Global registry of engine adapters */
const registry = new Map<EngineId, EngineAdapter>();

export function registerEngine(adapter: EngineAdapter): void {
  registry.set(adapter.id, adapter);
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
