import { execFileSync, execFile, ExecFileSyncOptions, ExecFileOptions } from 'child_process';

/**
 * Safe wrappers around the GitHub CLI (`gh`).
 *
 * SECURITY: these helpers pass every argument as a discrete array element with
 * `shell: false`, so user-controlled values (issue/repo/owner/label/body) can
 * NEVER break out into the shell. Do not reintroduce string-interpolated
 * `execSync(`gh ...`)` calls — that path is a command-injection vector.
 */

/** Run `gh` synchronously with array args and no shell. Returns stdout as a string. */
export function ghSync(args: string[], opts: ExecFileSyncOptions = {}): string {
  const out = execFileSync('gh', args, { encoding: 'utf-8', shell: false, ...opts });
  // execFileSync returns null when stdout isn't piped (e.g. stdio:'ignore').
  if (out == null) { return ''; }
  return typeof out === 'string' ? out : out.toString();
}

/** Run `gh` fire-and-forget with array args and no shell. */
export function ghAsync(
  args: string[],
  opts: ExecFileOptions = {},
  cb: (err: Error | null) => void = () => {},
): void {
  execFile('gh', args, { shell: false, ...opts }, (err) => cb(err));
}
