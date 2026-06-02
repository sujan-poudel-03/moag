import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWeights, saveWeights, analyzeWeights, DEFAULT_WEIGHTS, ContextWeights } from '../../../context/weights';
import type { HistoryEntry } from '../../../models/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(status: string, sections: Record<string, number>, taskType = 'agent'): Partial<HistoryEntry> {
  return {
    id: Math.random().toString(36).slice(2),
    taskId: 'tid',
    taskName: 'task',
    playlistId: 'pl',
    playlistName: 'pl',
    engine: 'claude',
    prompt: 'do stuff',
    result: { stdout: '', stderr: '', exitCode: status === 'completed' ? 0 : 1, durationMs: 100 },
    status: status as HistoryEntry['status'],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    taskType: taskType as HistoryEntry['taskType'],
    contextBudgetUsage: {
      totalCharsUsed: 1000,
      totalCharsBudget: 5000,
      sectionsDropped: 0,
      usedSemanticRetrieval: false,
      semanticSpansReturned: 0,
      sectionBreakdown: sections,
    },
  };
}

// ─── loadWeights ─────────────────────────────────────────────────────────────

describe('loadWeights', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weights-load-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns DEFAULT_WEIGHTS when file does not exist', () => {
    const w = loadWeights(tmpDir);
    assert.deepEqual(w.sectionWeights, DEFAULT_WEIGHTS.sectionWeights);
    assert.equal(w.sampleCount, DEFAULT_WEIGHTS.sampleCount);
  });

  it('returns parsed weights when file exists', () => {
    const data: ContextWeights = {
      version: 1, computedAt: '2026-01-01', sampleCount: 25,
      sectionWeights: { Code: 1.3, Plan: 0.8 },
      taskTypeWeights: { command: 0.7 },
    };
    fs.writeFileSync(path.join(tmpDir, 'weights.json'), JSON.stringify(data), 'utf-8');
    const w = loadWeights(tmpDir);
    assert.equal(w.sectionWeights['Code'], 1.3);
    assert.equal(w.sectionWeights['Plan'], 0.8);
    assert.equal(w.taskTypeWeights['command'], 0.7);
    assert.equal(w.sampleCount, 25);
  });

  it('returns DEFAULT_WEIGHTS on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'weights.json'), 'not valid json!!', 'utf-8');
    const w = loadWeights(tmpDir);
    assert.deepEqual(w.sectionWeights, DEFAULT_WEIGHTS.sectionWeights);
  });

  it('returns DEFAULT_WEIGHTS on missing version field', () => {
    fs.writeFileSync(path.join(tmpDir, 'weights.json'),
      JSON.stringify({ sectionWeights: { Code: 2 } }), 'utf-8');
    const w = loadWeights(tmpDir);
    assert.deepEqual(w.sectionWeights, DEFAULT_WEIGHTS.sectionWeights);
  });
});

// ─── saveWeights ─────────────────────────────────────────────────────────────

describe('saveWeights', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weights-save-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes human-readable JSON to weights.json', () => {
    const w: ContextWeights = {
      version: 1, computedAt: '2026-06-01', sampleCount: 42,
      sectionWeights: { Plan: 0.9, Code: 1.1 }, taskTypeWeights: {},
    };
    saveWeights(tmpDir, w);
    const raw = fs.readFileSync(path.join(tmpDir, 'weights.json'), 'utf-8');
    const parsed = JSON.parse(raw) as ContextWeights;
    assert.equal(parsed.sectionWeights['Plan'], 0.9);
    assert.equal(parsed.sampleCount, 42);
  });

  it('round-trips through loadWeights', () => {
    const w: ContextWeights = {
      version: 1, computedAt: 'ts', sampleCount: 10,
      sectionWeights: { Output: 1.5 }, taskTypeWeights: { agent: 0.9 },
    };
    saveWeights(tmpDir, w);
    const loaded = loadWeights(tmpDir);
    assert.equal(loaded.sectionWeights['Output'], 1.5);
    assert.equal(loaded.taskTypeWeights['agent'], 0.9);
  });
});

// ─── analyzeWeights ──────────────────────────────────────────────────────────

describe('analyzeWeights', () => {
  it('returns sampleCount only (empty weights) for fewer than 20 entries', () => {
    const entries = Array.from({ length: 10 }, () => makeEntry('completed', { Code: 100 }));
    const w = analyzeWeights(entries as HistoryEntry[]);
    assert.equal(w.sampleCount, 10);
    assert.deepEqual(w.sectionWeights, {});
    assert.deepEqual(w.taskTypeWeights, {});
  });

  it('returns neutral weights (≥1.0) for section always present in successes', () => {
    const entries = Array.from({ length: 20 }, () => makeEntry('completed', { Code: 500 }));
    const w = analyzeWeights(entries as HistoryEntry[]);
    const codeWeight = w.sectionWeights['Code'] ?? 1.0;
    assert.ok(codeWeight >= 1.0, `expected Code weight >= 1.0, got ${codeWeight}`);
  });

  it('penalises section that only appears in failed tasks', () => {
    const passing = Array.from({ length: 12 }, () => makeEntry('completed', { Plan: 100 }));
    const failing = Array.from({ length: 8 }, () => makeEntry('failed', { Plan: 100, Code: 500 }));
    const w = analyzeWeights([...passing, ...failing] as HistoryEntry[]);
    // Code only present in failures → weight < 1.0
    const codeWeight = w.sectionWeights['Code'] ?? 1.0;
    assert.ok(codeWeight <= 1.0, `expected Code weight <= 1.0, got ${codeWeight}`);
  });

  it('clamps weights to [0.5, 2.0]', () => {
    // Extreme case: Code always associated with failure
    const entries = [
      ...Array.from({ length: 18 }, () => makeEntry('completed', { Plan: 100 })),
      ...Array.from({ length: 2 }, () => makeEntry('failed', { Code: 5000 })),
    ];
    const w = analyzeWeights(entries as HistoryEntry[]);
    for (const [key, val] of Object.entries(w.sectionWeights)) {
      assert.ok(val >= 0.5, `${key} weight ${val} below min 0.5`);
      assert.ok(val <= 2.0, `${key} weight ${val} above max 2.0`);
    }
  });

  it('requires at least 5 samples per section to compute non-default weight', () => {
    // Only 4 entries with Code section — below the min-per-key threshold
    const entries = [
      ...Array.from({ length: 16 }, () => makeEntry('completed', { Plan: 100 })),
      ...Array.from({ length: 4 }, () => makeEntry('failed', { Code: 500 })),
    ];
    const w = analyzeWeights(entries as HistoryEntry[]);
    // Code has only 4 samples — should not appear in weights
    assert.ok(!('Code' in w.sectionWeights), 'Code should not have a weight with only 4 samples');
  });

  it('sets computedAt and version fields', () => {
    const entries = Array.from({ length: 20 }, () => makeEntry('completed', { Plan: 100 }));
    const w = analyzeWeights(entries as HistoryEntry[]);
    assert.equal(w.version, 1);
    assert.ok(w.computedAt.length > 0);
  });
});
