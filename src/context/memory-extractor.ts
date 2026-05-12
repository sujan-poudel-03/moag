// ─── Memory extractor — compresses task stdout into a compact summary ───

/** Matches lines that are pure noise: spinners, horizontal rules, progress bars */
const NOISE_LINE = /^[\s\-─━═|/\\*+.>⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u;

/** Matches agent-emitted file-change count summaries */
const FILE_CHANGED_RE = /\b\d+\s+files?\s+(?:changed|modified|created|deleted|updated)\b/i;

const SUMMARY_MAX_CHARS = 250;
const TAIL_LINE_COUNT = 8;

/**
 * Compress task stdout into a compact summary string (~250 chars).
 *
 * Takes the last TAIL_LINE_COUNT meaningful (non-noise) lines and joins them.
 * Prepends a file-count prefix when `changedFiles` is provided and the tail
 * doesn't already mention a file count.
 *
 * Returns '' when stdout is empty and no changedFiles are provided.
 */
export function extractSummary(stdout: string, changedFiles?: string[]): string {
  const meaningful = stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 4 && !NOISE_LINE.test(l));

  if (meaningful.length === 0) {
    if (changedFiles && changedFiles.length > 0) {
      const n = changedFiles.length;
      return `${n} file${n === 1 ? '' : 's'} changed`;
    }
    return '';
  }

  const tail = meaningful.slice(-TAIL_LINE_COUNT).join(' ').replace(/\s+/g, ' ');

  const prefix =
    !FILE_CHANGED_RE.test(tail) && changedFiles && changedFiles.length > 0
      ? `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed. `
      : '';

  return (prefix + tail).slice(0, SUMMARY_MAX_CHARS);
}
