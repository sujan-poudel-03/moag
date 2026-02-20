// ─── Engine adapter interface and registry ───

import { EngineId, EngineResult } from '../models/types';
import { OutputCallback } from './base-cli';

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
