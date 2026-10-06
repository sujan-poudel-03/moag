// ─── Shared fixtures for the project-detector tests ───

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Create a temp repo from a `relative path → content` map. */
export function makeRepo(prefix: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return dir;
}
