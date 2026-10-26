// ─── CHANGELOG.md parsing (pure) ───
//
// CHANGELOG.md follows Keep a Changelog: one `## [x.y.z] - YYYY-MM-DD` heading
// per release, newest first, after an `## [Unreleased]` section. The release
// pipeline (scripts/release-notes.js) takes a tag's notes from here, and a repo
// test holds the file to its shape. No vscode, no fs: text in, data out.

/** One versioned section of the changelog. */
export interface ChangelogSection {
  /** `x.y.z`. */
  version: string;
  /** `YYYY-MM-DD`, or `'not released'` for a version number that was skipped. */
  date: string;
  /** The section's text between its heading and the next `## ` heading, trimmed. */
  body: string;
}

/** A `## [x.y.z] - date` heading. Anything after the bracket that is not `- <date>` gives an empty date. */
const HEADING_RE = /^## \[([^\]]+)\](?:\s+-\s+(.+?))?\s*$/;

/**
 * The versioned sections of a changelog, in file order. `## [Unreleased]` is
 * skipped; so is anything before the first `## ` heading. Accepts LF or CRLF.
 */
export function parseChangelog(text: string): ChangelogSection[] {
  const lines = text.split(/\r?\n/);
  const sections: ChangelogSection[] = [];
  let current: { version: string; date: string; lines: string[] } | null = null;
  let inUnreleased = false;

  const flush = (): void => {
    if (current) { sections.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() }); }
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      const m = HEADING_RE.exec(line);
      const label = m ? m[1].trim() : '';
      inUnreleased = /^unreleased$/i.test(label);
      if (m && !inUnreleased) { current = { version: label, date: (m[2] ?? '').trim(), lines: [] }; }
      continue;
    }
    // Link reference definitions (`[0.9.15]: https://...`) close the last section.
    if (/^\[[^\]]+\]:\s*\S/.test(line)) { flush(); inUnreleased = false; continue; }
    if (current && !inUnreleased) { current.lines.push(line); }
  }
  flush();
  return sections;
}

/** The body of `version`'s section, or null when the changelog has no such section. */
export function extractSection(text: string, version: string): string | null {
  const wanted = version.replace(/^v/, '');
  const hit = parseChangelog(text).find((s) => s.version === wanted);
  return hit ? hit.body : null;
}
