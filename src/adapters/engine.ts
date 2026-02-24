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
}

/**
 * Check availability of multiple engines in parallel.
 * Returns a Map from EngineId to availability info.
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
      const available = await commandExists(command);
      results.set(id, { available, command, displayName: adapter.displayName });
    })
  );

  return results;
}
