// ─── Git, run safely against repositories an agent can write to ───
//
// The host agent runs as the machine's main user — it holds the device key and the tunnel token —
// and it runs git on project repositories that AI agents edit. A repository can carry config that
// makes git run code: hooks, core.fsmonitor, core.hooksPath, filter drivers, ext:: transports. So:
//
//   1. The host never runs git with a project repository's own config. It keeps a MIRROR of each
//      approved project under <stateDir>/host/repos/<id>.git, filled by cloning/fetching the project
//      as a remote (git reads none of the source repository's config to do that), and makes its
//      worktrees from the mirror, whose config only the host writes.
//   2. Every call still carries the options below, so even a config that slipped into a mirror
//      cannot run anything: hooks point at an empty folder, fsmonitor is off, transports are
//      limited to https and ssh (plus local paths, only for the mirror refresh), no prompts.
//
// Filter drivers named in a branch's .gitattributes are inert in the mirror: a driver runs only when
// git config defines it, and the mirror's config defines none.
//
// Pure; imports path only. Never vscode.

import * as path from 'path';

export interface SafeGitOptions {
  /** An empty folder the host owns; core.hooksPath points here. */
  emptyHooksDir: string;
  /** Allow local-path transport — only for refreshing the mirror from the approved project folder. */
  allowLocal?: boolean;
}

/** `git` arguments with the hardening options in front of `args`. */
export function safeGitArgs(args: string[], opts: SafeGitOptions): string[] {
  return [
    '-c', `core.hooksPath=${opts.emptyHooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    '-c', `protocol.file.allow=${opts.allowLocal ? 'always' : 'never'}`,
    '-c', 'credential.helper=',
    '-c', 'core.sshCommand=ssh -o BatchMode=yes',
    '-c', 'submodule.recurse=false',
    ...args,
  ];
}

/** Environment for git: no system or global config, never prompt. Applied on top of childEnv(). */
export function safeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

/** The mirror of an approved project. */
export function mirrorPath(stateDir: string, projectId: string): string {
  return path.join(stateDir, 'host', 'repos', `${projectId}.git`);
}
