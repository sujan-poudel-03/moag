// ─── File I/O helpers ───

import * as fs from 'fs';
import * as path from 'path';

/** Read a text file, returning null if it doesn't exist */
export function readFileSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Write a text file, creating directories as needed */
export function writeFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** Check if a file exists */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/** Resolve a path relative to a base directory */
export function resolvePath(base: string, relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(base, relative);
}
