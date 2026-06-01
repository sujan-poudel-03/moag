// ─── Codebase Knowledge Graph ───────────────────────────────────────────────
//
// Builds an in-memory symbol index from the workspace at activation time and
// keeps it current via incremental file-save updates.
//
// Stage 0 in runRetrievalCascade uses this graph for O(1) symbol lookup,
// replacing the O(50 files × N lines) regex scan for known symbols.

import * as fs from 'fs';
import * as path from 'path';
import type { SemanticSpan } from './semantic-provider';

export type KGNodeKind = 'function' | 'class' | 'interface' | 'const' | 'type' | 'enum';

export interface KGNode {
  /** The exported/defined symbol name (case-preserved) */
  symbol: string;
  /** Workspace-relative file path, e.g. "src/context/context-builder.ts" */
  filePath: string;
  /** 1-indexed line where the symbol is defined */
  startLine: number;
  /** 1-indexed last line of the definition context (startLine + context lines) */
  endLine: number;
  /** ±3 lines of context around the definition, pre-extracted */
  content: string;
  kind: KGNodeKind;
}

export interface KnowledgeGraph {
  /** Lowercased symbol name → matching nodes (multiple files may export same name) */
  symbols: Map<string, KGNode[]>;
  /** Date.now() when this index was built */
  builtAt: number;
  /** Number of files indexed */
  fileCount: number;
}

// ─── Extraction patterns ─────────────────────────────────────────────────────

const EXPORT_PATTERN =
  /^export\s+(?:async\s+)?(?:(function|class|interface|type|const|enum|abstract\s+class))\s+([A-Za-z_][A-Za-z0-9_]*)/;

const TOP_LEVEL_PATTERN =
  /^(?:(function|class))\s+([A-Za-z_][A-Za-z0-9_]{3,})\s*[(<{]/;

const CONTEXT_LINES = 3;
const MAX_FILE_BYTES = 200_000; // 200 KB — skip very large generated files
const MAX_FILES = 500;
const SKIP_DIRS = new Set(['node_modules', 'out', '.git', 'dist', 'build', '.next', '__pycache__']);

// ─── Build ───────────────────────────────────────────────────────────────────

/** Scan the workspace and return a fresh KnowledgeGraph. */
export function buildKG(cwd: string): KnowledgeGraph {
  const symbols = new Map<string, KGNode[]>();
  let fileCount = 0;

  const files = collectFiles(cwd);
  for (const filePath of files) {
    if (fileCount >= MAX_FILES) { break; }
    indexFile(symbols, cwd, filePath);
    fileCount++;
  }

  return { symbols, builtAt: Date.now(), fileCount };
}

/**
 * Incrementally update the graph when a single file is saved.
 * Removes all previous entries for that file and re-indexes it.
 */
export function rebuildKGForFile(kg: KnowledgeGraph, cwd: string, relPath: string): void {
  // Remove all existing nodes for this file
  for (const [key, nodes] of kg.symbols) {
    const filtered = nodes.filter(n => n.filePath !== relPath);
    if (filtered.length === 0) {
      kg.symbols.delete(key);
    } else if (filtered.length !== nodes.length) {
      kg.symbols.set(key, filtered);
    }
  }
  // Re-index the file
  indexFile(kg.symbols, cwd, relPath);
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Look up a list of symbol names in the KG and return matching SemanticSpans.
 * Confidence 0.7 — higher than rg (0.65) because the index is structured.
 */
export function lookupSymbols(kg: KnowledgeGraph, symbolNames: string[]): SemanticSpan[] {
  const seen = new Set<string>(); // filePath:startLine dedup key
  const spans: SemanticSpan[] = [];

  for (const name of symbolNames) {
    const nodes = kg.symbols.get(name.toLowerCase());
    if (!nodes) { continue; }
    for (const node of nodes) {
      const key = `${node.filePath}:${node.startLine}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      spans.push({
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        content: node.content,
        confidence: 0.7,
        label: node.symbol,
      });
    }
  }

  return spans;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function collectFiles(cwd: string): string[] {
  const results: string[] = [];
  walkDir(cwd, cwd, results);
  return results;
}

function walkDir(base: string, dir: string, out: string[]): void {
  if (out.length >= MAX_FILES) { return; }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) { return; }
    if (SKIP_DIRS.has(entry.name)) { continue; }
    if (entry.isDirectory()) {
      walkDir(base, path.join(dir, entry.name), out);
    } else if (entry.isFile() && isIndexableFile(entry.name)) {
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
}

function isIndexableFile(name: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php)$/.test(name) &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.min.js') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.spec.ts');
}

function indexFile(symbols: Map<string, KGNode[]>, cwd: string, relPath: string): void {
  const absPath = path.join(cwd, relPath);
  let stat: fs.Stats;
  try { stat = fs.statSync(absPath); } catch { return; }
  if (stat.size > MAX_FILE_BYTES) { return; }

  let src: string;
  try { src = fs.readFileSync(absPath, 'utf-8'); } catch { return; }

  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = EXPORT_PATTERN.exec(line) ?? TOP_LEVEL_PATTERN.exec(line);
    if (!match) { continue; }

    const kindStr = (match[1] ?? 'function').replace('abstract ', '').trim();
    const symbolName = match[2];
    if (!symbolName || symbolName.length < 2) { continue; }

    const startLine = i + 1; // 1-indexed
    const ctxStart = Math.max(0, i - CONTEXT_LINES);
    const ctxEnd = Math.min(lines.length - 1, i + CONTEXT_LINES + 5); // a bit more after
    const content = lines.slice(ctxStart, ctxEnd + 1).join('\n');

    const node: KGNode = {
      symbol: symbolName,
      filePath: relPath.replace(/\\/g, '/'), // normalize to forward slashes
      startLine,
      endLine: ctxEnd + 1,
      content,
      kind: kindStr as KGNodeKind,
    };

    const key = symbolName.toLowerCase();
    const existing = symbols.get(key);
    if (existing) {
      existing.push(node);
    } else {
      symbols.set(key, [node]);
    }
  }
}
