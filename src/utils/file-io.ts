// ─── File I/O helpers ───

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

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

// ─── Atomic write ───

/** Error codes a Windows rename transiently fails with (AV scanners, indexers). */
const WIN_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WIN_RENAME_RETRIES = 3;
const WIN_RENAME_DELAY_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `content` to `filePath` atomically: write a uniquely named temp file
 * beside the target (created with `mode`), then rename it over the target.
 * A crash mid-write leaves the original file intact. On Windows the rename is
 * retried up to 3 times on EPERM/EBUSY/EACCES. On failure the temp file is
 * removed and the error rethrown.
 */
export function writeFileAtomicSync(filePath: string, content: string, mode: number = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (process.platform === 'win32' && attempt < WIN_RENAME_RETRIES && WIN_RETRY_CODES.has(code)) {
          sleepSync(WIN_RENAME_DELAY_MS);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
