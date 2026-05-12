import { strict as assert } from 'assert';
import { extractSummary } from '../../../context/memory-extractor';

describe('extractSummary', () => {
  it('returns empty string for empty stdout with no changed files', () => {
    assert.equal(extractSummary(''), '');
    assert.equal(extractSummary('   \n  \n'), '');
  });

  it('returns file count only when stdout is empty but changedFiles provided', () => {
    const result = extractSummary('', ['src/foo.ts', 'src/bar.ts']);
    assert.equal(result, '2 files changed');
  });

  it('returns singular "file" when only one file changed', () => {
    const result = extractSummary('', ['src/foo.ts']);
    assert.equal(result, '1 file changed');
  });

  it('extracts the last meaningful lines from stdout', () => {
    const stdout = [
      'Reading auth.ts...',
      'Thinking about the implementation...',
      '',
      'Updated validateToken to handle refresh rotation.',
      'Added refreshAccessToken function.',
      'Done.',
    ].join('\n');
    const result = extractSummary(stdout);
    assert.ok(result.includes('Updated validateToken'));
    assert.ok(result.includes('Added refreshAccessToken'));
    assert.ok(result.includes('Done.'));
  });

  it('filters out noise lines (spinner chars, horizontal rules)', () => {
    const stdout = [
      '────────────────',
      '⠙ working...',
      'Refactored runner.ts to use play lock.',
      '─────────────────',
    ].join('\n');
    const result = extractSummary(stdout);
    assert.ok(result.includes('Refactored runner.ts'));
    assert.ok(!result.includes('────'));
  });

  it('prepends file count when stdout has no file-change mention', () => {
    const stdout = 'Added OAuth token refresh flow.';
    const result = extractSummary(stdout, ['auth.ts', 'auth.service.ts']);
    assert.ok(result.startsWith('2 files changed.'));
    assert.ok(result.includes('Added OAuth token refresh flow.'));
  });

  it('does not double-count when stdout already mentions files changed', () => {
    const stdout = 'Updated 3 files changed: auth.ts, index.ts, types.ts';
    const result = extractSummary(stdout, ['auth.ts', 'index.ts', 'types.ts']);
    assert.ok(!result.startsWith('3 files changed.'));
    assert.ok(result.includes('Updated 3 files changed'));
  });

  it('truncates output to 250 chars', () => {
    const stdout = 'A'.repeat(500);
    const result = extractSummary(stdout);
    assert.ok(result.length <= 250);
  });

  it('handles long stdout by using only the tail lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: doing work on file${i}.ts`);
    const result = extractSummary(lines.join('\n'));
    // Should contain one of the last 8 lines
    assert.ok(result.includes('Line 100'));
    // Should not contain early lines
    assert.ok(!result.includes('Line 1:'));
  });

  it('works with real agent-style output', () => {
    const stdout = [
      "I'll implement the refresh token flow.",
      '',
      'Reading src/auth.ts...',
      'I see the validateToken function.',
      '',
      '✓ Updated src/auth.ts',
      '✓ Updated src/auth.service.ts',
      '',
      'Added refreshAccessToken() with automatic token rotation.',
      'Updated validateToken to use the new refresh flow.',
      '2 files changed.',
    ].join('\n');
    const result = extractSummary(stdout, ['src/auth.ts', 'src/auth.service.ts']);
    assert.ok(result.length <= 250);
    assert.ok(result.includes('refreshAccessToken'));
  });
});
