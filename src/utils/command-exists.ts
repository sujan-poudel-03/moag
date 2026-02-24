// ─── Cross-platform CLI command detection ───

import { execFile } from 'child_process';

/**
 * Check if a command is available on the system PATH.
 * Uses `where` on Windows, `which` on Unix.
 */
export function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!command) {
      resolve(false);
      return;
    }
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFile(checker, [command], (error) => {
      resolve(!error);
    });
  });
}