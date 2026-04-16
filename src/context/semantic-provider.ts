// ─── Local semantic search provider interface ───
//
// MOAG supports optional local semantic indexing backends so context retrieval
// can use ranked code spans instead of whole files. When a provider is installed
// it is called after the rg/glob pass; results are merged by confidence score.
// When no provider is registered (or confidence is low), the system falls back
// to deterministic rg-based retrieval so results are always predictable.

/** A single matching span returned by a semantic search provider */
export interface SemanticSpan {
  /** Relative path within the workspace */
  filePath: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line (inclusive) */
  endLine: number;
  /** Raw text of the matched span */
  content: string;
  /** Provider confidence 0–1 (below CONFIDENCE_THRESHOLD triggers fallback) */
  confidence: number;
  /** Optional label from the provider (e.g. function name, symbol) */
  label?: string;
}

/** Query options passed to the provider */
export interface SemanticQuery {
  /** Natural-language or symbol query */
  query: string;
  /** Workspace root path */
  cwd: string;
  /** Maximum number of spans to return */
  maxSpans?: number;
  /** File glob filter (e.g. '*.ts') */
  fileGlob?: string;
}

/** Contract every semantic search provider must implement */
export interface SemanticProvider {
  readonly name: string;
  /**
   * Returns true if the provider is ready to serve queries (index built, process running, etc.).
   * Should be cheap to call (no I/O blocking).
   */
  isReady(): boolean;
  /** Perform a semantic search and return ranked spans */
  search(query: SemanticQuery): Promise<SemanticSpan[]>;
}

/** Minimum confidence score to trust a provider result instead of falling back */
export const CONFIDENCE_THRESHOLD = 0.45;

/**
 * Global registry holding at most one active provider.
 * Extensions or plugins call registerProvider() at activation time.
 */
let _activeProvider: SemanticProvider | null = null;

/** Register a semantic provider. Replaces any existing registration. */
export function registerProvider(provider: SemanticProvider): void {
  _activeProvider = provider;
}

/** Unregister the current provider (e.g. on deactivation). */
export function unregisterProvider(): void {
  _activeProvider = null;
}

/** Get the currently registered provider, or null if none. */
export function getProvider(): SemanticProvider | null {
  return _activeProvider;
}

/**
 * Run a semantic search with automatic fallback.
 *
 * Returns:
 * - The provider's spans when available and high-confidence.
 * - An empty array when the provider is absent, not ready, or returns
 *   low-confidence results — callers should then use rg/glob retrieval.
 */
export async function semanticSearch(query: SemanticQuery): Promise<SemanticSpan[]> {
  const provider = _activeProvider;
  if (!provider || !provider.isReady()) {
    return [];
  }

  try {
    const spans = await provider.search(query);
    // Filter to high-confidence spans only
    const confident = spans.filter(s => s.confidence >= CONFIDENCE_THRESHOLD);
    return confident;
  } catch {
    // Provider error → fall back to deterministic retrieval
    return [];
  }
}

/**
 * Build a context string from semantic spans.
 * Spans are formatted as fenced code blocks with file/line metadata.
 */
export function formatSpans(spans: SemanticSpan[], budget: number): string {
  if (spans.length === 0) { return ''; }

  const parts: string[] = [];
  let total = 0;

  for (const span of spans) {
    const header = `--- ${span.filePath}:${span.startLine}-${span.endLine}${span.label ? ` (${span.label})` : ''} ---`;
    const block = `${header}\n${span.content}`;
    if (total + block.length > budget) {
      break;
    }
    parts.push(block);
    total += block.length;
  }

  return parts.join('\n\n');
}
