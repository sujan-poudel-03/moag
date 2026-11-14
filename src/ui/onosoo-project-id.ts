// ─── ONOSOO project ID — the copy command and the dashboard segment ───
//
// Puts the ONOSOO project ID of a workspace folder on the clipboard, exactly as runs report it
// (src/headless/project-id.ts holds the rule, the reasons and the scrub context), and keeps the
// model the dashboard's "ONOSOO project" segment renders. Never reads or waits for the runner:
// identity lookups are read-only git calls through the relay host's cache.

import * as vscode from 'vscode';
import {
  cachedResolution, deviceKeyFor, PROJECT_ID_DEADLINE_MS, PROJECT_ID_REASON_PHRASES, projectIdAsSent, ProjectIdCheck, ProjectIdReason,
  projectIdScrubContext, projectSegmentModel, ProjectSegmentModel, resolveFolderIdentity, resolveWithDeadline,
} from '../headless/project-id';
import {
  identityCacheKey, IdentityCacheTimers, ProjectIdentityResolution, resolveProjectIdentityWithReason,
} from '../headless/project-identity';
import { hostSecret } from '../core/host';
import type { OnosooProjectView } from './onosoo-relay-host';
import {
  noOnosooFolder, onosooProjectIdAbsent, onosooProjectIdCopied, onosooProjectIdCopyFailed, onosooProjectIdNotSent, onosooProjectIdTimeout,
  showError, showInfo, showWarning,
} from '../utils/user-messages';

// ─── Shared ───

/** The stored Anthropic key: a run's redactor knows it, so the rule must too. */
type StoredKeyReader = () => Promise<string | undefined>;

const defaultStoredKey: StoredKeyReader = () => hostSecret('anthropicApiKey');

/**
 * Check `identity` against the run-meta rule with the secrets a VS Code run from `dir` redacts:
 * the reporting secrets of `env`, the device key when paired, and the stored Anthropic key.
 */
async function checkAsSent(
  resolution: Extract<ProjectIdentityResolution, { reason: null }>,
  dir: string,
  env: NodeJS.ProcessEnv,
  storedKey: StoredKeyReader,
): Promise<ProjectIdCheck> {
  let stored: string | undefined;
  try { stored = await storedKey(); } catch { stored = undefined; }
  return projectIdAsSent(resolution.identity, projectIdScrubContext(dir, env, [deviceKeyFor(env, dir), stored]));
}

// ─── Copy ONOSOO Project ID ───

/** Injected inputs of {@link cmdCopyOnosooProjectId} (tests); every field defaults to the real thing. */
export interface CopyProjectIdDeps {
  deadlineMs?: number;
  timers?: IdentityCacheTimers;
  storedAnthropicKey?: StoredKeyReader;
  /** Resolves a folder when the view's cache has no answer (default: git). */
  resolveDirect?: (dir: string) => Promise<ProjectIdentityResolution>;
}

interface FolderPick extends vscode.QuickPickItem {
  folder: vscode.WorkspaceFolder;
}

/** The folder to copy the ID of: the only one, or the user's pick; undefined when cancelled. */
async function pickFolder(folders: readonly vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder | undefined> {
  if (folders.length === 1) { return folders[0]; }
  const items: FolderPick[] = folders.map((folder, i) => ({
    label: folder.name,
    detail: folder.uri.fsPath,
    ...(i === 0 ? { description: 'Runs started in VS Code report this folder' } : {}),
    folder,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Copy ONOSOO Project ID',
    placeHolder: 'Choose the folder whose ONOSOO project ID to copy',
  });
  return picked?.folder;
}

/**
 * MOAG: Copy ONOSOO Project ID. Resolves the folder's identity (cached, or within
 * PROJECT_ID_DEADLINE_MS behind a cancellable progress notification), applies the run-meta
 * rule, and copies only a key runs would send. Never reads the runner and is never blocked by
 * a run. Cancelling the picker or the progress does nothing and says nothing.
 */
export async function cmdCopyOnosooProjectId(view: OnosooProjectView | undefined, deps: CopyProjectIdDeps = {}): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void showInfo(noOnosooFolder());
    return;
  }
  const folder = await pickFolder(folders);
  if (!folder) { return; }
  const dir = folder.uri.fsPath;
  const resolveDirect = deps.resolveDirect ?? ((d: string) => resolveProjectIdentityWithReason(d, { env: view?.env() ?? process.env }));

  let resolution = view ? cachedResolution(view.identities, dir) : undefined;
  if (!resolution) {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Resolving ONOSOO project ID…', cancellable: true },
      async (_progress, token) => {
        const ac = new AbortController();
        const sub = token?.onCancellationRequested?.(() => ac.abort());
        try {
          if (token?.isCancellationRequested) { ac.abort(); }
          return await resolveWithDeadline(
            resolveFolderIdentity(view?.identities ?? null, dir, resolveDirect),
            deps.deadlineMs ?? PROJECT_ID_DEADLINE_MS,
            { signal: ac.signal, timers: deps.timers },
          );
        } finally {
          sub?.dispose();
        }
      },
    );
    if (outcome.kind === 'cancelled') { return; }
    if (outcome.kind === 'timeout') {
      void showWarning(onosooProjectIdTimeout());
      return;
    }
    resolution = outcome.value ?? { identity: null, reason: 'git_unreadable' };
  }

  if (resolution.identity === null) {
    void showWarning(onosooProjectIdAbsent(PROJECT_ID_REASON_PHRASES[resolution.reason]));
    return;
  }

  const env = view?.env() ?? process.env;
  const check = await checkAsSent(resolution, dir, env, deps.storedAnthropicKey ?? defaultStoredKey);
  if (!check.ok) {
    void showWarning(onosooProjectIdNotSent());
    return;
  }

  await vscode.env.clipboard.writeText(check.project_key);
  const first = folders[0];
  const notFirst = identityCacheKey(dir) !== identityCacheKey(first.uri.fsPath);
  void showInfo(onosooProjectIdCopied(check.project_key, check.repo_url ?? undefined, notFirst ? first.name : undefined));
}

// ─── Dashboard segment ───

/** The model behind the dashboard's "ONOSOO project" segment, and its Copy and Open actions. */
export interface OnosooProjectSegment {
  /** The last model; `hidden` until the first refresh decides otherwise. */
  current(): ProjectSegmentModel;
  /** Called with each new model (only when it changed). */
  onDidChange(listener: (m: ProjectSegmentModel) => void): { dispose(): void };
  /** Recompute from the relay host's state; a lookup it needs is started, never awaited. */
  refresh(): void;
  /** Copy the held key after checking it again; `ok` only when it is on the clipboard. Never rejects. */
  copy(): Promise<{ ok: boolean; reason?: ProjectIdReason }>;
  /** Open the held repository URL, only when it passes the rule now. Takes no URL from anyone. */
  openRepository(): Promise<void>;
  dispose(): void;
}

/** Injected inputs of {@link createOnosooProjectSegment} (tests). */
export interface OnosooProjectSegmentDeps {
  storedAnthropicKey?: StoredKeyReader;
  /** Resolves the folder when the cache holds a null without a reason (default: git). */
  resolveDirect?: (dir: string) => Promise<ProjectIdentityResolution>;
}

/**
 * The dashboard segment over the relay host's project view: always the first workspace folder,
 * shown while paired. Recomputes on every view change; a result from an older refresh is
 * dropped, a folder change goes straight back to "resolving", and a refresh of the same folder
 * keeps the last model until the new one is known (no flicker).
 */
export function createOnosooProjectSegment(view: OnosooProjectView, deps: OnosooProjectSegmentDeps = {}): OnosooProjectSegment {
  const storedKey = deps.storedAnthropicKey ?? defaultStoredKey;
  const resolveDirect = deps.resolveDirect ?? ((d: string) => resolveProjectIdentityWithReason(d, { env: view.env() }));
  const listeners = new Set<(m: ProjectSegmentModel) => void>();
  /** Answers from resolveDirect, for folders the cache holds as null with no reason. */
  const direct = new Map<string, ProjectIdentityResolution>();
  const warming = new Set<string>();
  let model: ProjectSegmentModel = { kind: 'hidden' };
  let modelFolder: string | null = null;
  let seq = 0;
  let disposed = false;

  const emit = (next: ProjectSegmentModel, folderKey: string | null): void => {
    modelFolder = folderKey;
    if (JSON.stringify(next) === JSON.stringify(model)) { return; }
    model = next;
    for (const l of [...listeners]) {
      try { l(model); } catch { /* a listener never disturbs the segment */ }
    }
  };

  /** What is known about `folder`: the cache's answer, else a direct answer. */
  const known = (folder: string): ProjectIdentityResolution | undefined =>
    cachedResolution(view.identities, folder) ?? direct.get(identityCacheKey(folder));

  /** Start (once at a time per folder) the lookup `folder` needs, then refresh. */
  const lookUp = (folder: string, fk: string): void => {
    if (warming.has(fk)) { return; }
    warming.add(fk);
    const done = (): void => { warming.delete(fk); refresh(); };
    void view.identities.warm(folder).then(async (v) => {
      if (v === null && view.identities.reasonOf(folder) === undefined) {
        let r: ProjectIdentityResolution;
        try { r = await resolveDirect(folder); } catch { r = { identity: null, reason: 'git_unreadable' }; }
        direct.set(fk, r);
      }
    }).then(done, done);
  };

  const refresh = (): void => {
    if (disposed) { return; }
    const my = ++seq;
    try {
      const status = view.status();
      const folder = view.folder();
      if (status === 'none' || !folder) {
        emit({ kind: 'hidden' }, null);
        return;
      }
      const fk = identityCacheKey(folder);
      const firstName = view.isMultiRoot() ? view.firstFolderName() : null;
      const res = known(folder);
      if (!res) {
        // Same folder: keep what is shown (with the current status) until the answer lands.
        if (modelFolder === fk && model.kind !== 'hidden') {
          emit({ ...model, status } as ProjectSegmentModel, fk);
        } else {
          emit(projectSegmentModel(status, undefined, null, null), fk);
        }
        lookUp(folder, fk);
        return;
      }
      if (res.identity === null) {
        emit(projectSegmentModel(status, res, null, firstName), fk);
        return;
      }
      // Another folder's model (its key above all) is never shown while this one's is checked;
      // from hidden, nothing stale is on screen, so the key simply appears (no resolving flash).
      if (modelFolder !== fk && model.kind !== 'hidden') { emit(projectSegmentModel(status, undefined, null, null), fk); }
      const env = view.env();
      void checkAsSent(res, folder, env, storedKey).then((check) => {
        if (my !== seq || disposed) { return; }
        emit(projectSegmentModel(status, res, check, firstName), fk);
      }, () => undefined);
    } catch {
      /* the segment never disturbs the host */
    }
  };

  /** The held identity of the first folder, checked again with fresh inputs. */
  const recheck = async (): Promise<ProjectIdCheck | { ok: false; reason?: ProjectIdReason }> => {
    const folder = view.folder();
    if (!folder || view.status() === 'none') { return { ok: false }; }
    const res = known(folder);
    if (!res) { return { ok: false }; }
    if (res.identity === null) { return { ok: false, reason: res.reason }; }
    return checkAsSent(res, folder, view.env(), storedKey);
  };

  const sub = view.onDidChange(() => refresh());

  return {
    current: () => model,
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    refresh,
    copy: async () => {
      try {
        const check = await recheck();
        if (!check.ok) { return check.reason ? { ok: false, reason: check.reason } : { ok: false }; }
        try {
          await vscode.env.clipboard.writeText(check.project_key);
        } catch (err) {
          void showError(onosooProjectIdCopyFailed(err instanceof Error ? err.message : String(err)));
          return { ok: false };
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    openRepository: async () => {
      try {
        const check = await recheck();
        if (!check.ok || !check.project_key.startsWith('git:') || !check.repo_url) { return; }
        await vscode.env.openExternal(vscode.Uri.parse(check.repo_url));
      } catch { /* nothing opened */ }
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
      try { sub.dispose(); } catch { /* already gone */ }
    },
  };
}
