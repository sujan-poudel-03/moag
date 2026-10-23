// ─── Engine API keys: the shape, without the store (shared) ───
//
// What an engine API key may look like and which env var each keyed engine
// reads. The encrypted store itself (`server/secrets.ts`) is server-only; the
// headless CLI and the ONOSOO relay need just these two facts, and they ship in
// the extension while the server does not.

import { EngineId } from '../models/types';

/** Printable ASCII, no spaces: API keys are tokens, and this keeps control characters out of a child env. */
export const API_KEY_RE = /^[\x21-\x7e]{8,512}$/;

/**
 * Engines whose credentials the server stores, and the env var each is injected
 * as. Closed map: S3 covers `anthropic` only.
 */
export const KEYED_ENGINE_ENV: Readonly<Partial<Record<EngineId, string>>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
});
