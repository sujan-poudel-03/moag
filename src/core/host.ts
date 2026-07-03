// ─── Host port — the seam between MOAG's engine core and its environment ──────
//
// The engine core (runner, adapters, context-builder) must not depend on the
// VS Code API directly, so it can run unchanged inside the extension, the
// headless daemon/CLI, or any future host (server, CI, web UI). Everything the
// core needs from its environment is expressed by `MoagHost` and supplied once
// at startup via `setHost()`:
//
//   • extension      → src/extension.ts          (real `vscode` APIs)
//   • daemon / CLI   → src/headless/install-shim  (file-backed config)
//   • unit tests     → src/test/unit/test-setup   (in-memory mock config)
//
// Today the surface is tiny — configuration reads, a warning notice, and the
// workspace root — but routing it through this port is what keeps the core
// host-agnostic (Phase 1 of the engine/IDE decoupling).

/** A configuration namespace, mirroring `vscode.WorkspaceConfiguration`. */
export interface ConfigSection {
  get<T>(key: string, fallback: T): T;
  get<T>(key: string): T | undefined;
}

/** Everything the engine core needs from its runtime environment. */
export interface MoagHost {
  /** Read a configuration namespace (e.g. `'agentTaskPlayer.engines.claude'`). */
  getConfiguration(section: string): ConfigSection;
  /** Surface a non-blocking warning to the user/operator. */
  warn(message: string): void;
  /** Absolute path of the active workspace/project root. */
  workspaceRoot(): string;
}

let current: MoagHost | undefined;

/** Install the host. Call once at startup before the engine runs. */
export function setHost(host: MoagHost): void {
  current = host;
}

/** True once a host has been installed. */
export function hasHost(): boolean {
  return current !== undefined;
}

/** The installed host. Throws if `setHost()` was never called. */
export function host(): MoagHost {
  if (!current) {
    throw new Error(
      'MOAG host not configured: call setHost() before running the engine.',
    );
  }
  return current;
}

// ─── Convenience accessors (what the core actually imports) ───────────────────

export function getConfig(section: string): ConfigSection {
  return host().getConfiguration(section);
}

export function notifyWarn(message: string): void {
  host().warn(message);
}

export function workspaceRoot(): string {
  return host().workspaceRoot();
}
