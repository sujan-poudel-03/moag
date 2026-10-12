// ─── The host agent's calls to ONOSOO ───
//
// Same key, same base URL and same HTTP client as the relay (headless/onosoo-config.ts and
// onosoo-relay.ts): one machine, one identity. Routes are the v1.1 machine routes in ONOSOO's
// docs/builds/PROTOCOL.md: commands/poll, commands/<id>/result, environments, previews/redeem,
// previews/check, plus `events` with no events to report the host agent's capabilities.
//
// Never throws on an HTTP answer: callers branch on `status`. Rejects only on network failure.
// Imports no vscode.

import type { OnosooConfig } from '../headless/onosoo-config';
import { defaultHttpClient, REQUEST_TIMEOUT_MS, type RelayHttpClient } from '../headless/onosoo-relay';

export interface OnosooReply {
  status: number;
  json: Record<string, unknown> | null;
}

export type OnosooCall = (route: string, body: unknown) => Promise<OnosooReply>;

/** `https://x.supabase.co/functions/v1/builds/events` → `https://x.supabase.co/functions/v1/builds/`. */
export function buildsBase(endpoint: string): string {
  return endpoint.replace(/events$/, '');
}

export function createOnosooClient(config: Pick<OnosooConfig, 'endpoint' | 'key'>, http: RelayHttpClient = defaultHttpClient): OnosooCall {
  const base = buildsBase(config.endpoint);
  return async (route, body) => {
    const controller = new AbortController();
    const res = await http({
      url: base + route,
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    let json: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(res.body);
      json = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}
